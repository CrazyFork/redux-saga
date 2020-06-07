/**
 * 这个文件对 saga 每个 io effect 定义了如何具体运行. 首先也是最重要的是你需要理解
 * cb 这个在每个 effect 中的语义, 即 cb(result) 中的 result 最终对应你(user code)
 * 中 yield 中的返回
 */
import { SELF_CANCELLATION, TERMINATE } from '@redux-saga/symbols'
import * as is from '@redux-saga/is'
import * as effectTypes from './effectTypes'
import { channel, isEnd } from './channel'
// usage of proc here makes internal circular dependency
// this works fine, but it is a little bit unfortunate
import proc from './proc'
import resolvePromise from './resolvePromise'
import matcher from './matcher'
import { asap, immediately } from './scheduler'
import { current as currentEffectId } from './uid'
import {
  assignWithSymbols,
  createAllStyleChildCallbacks,
  createEmptyArray,
  makeIterator,
  noop,
  remove,
  shouldComplete,
  getMetaInfo,
} from './utils'

// return name of iterator or fn.
function getIteratorMetaInfo(iterator, fn) {
  if (iterator.isSagaIterator) {
    return { name: iterator.meta.name }
  }
  return getMetaInfo(fn)
}

function createTaskIterator({ context, fn, args }) {
  // catch synchronous failures; see #152 and #441
  try {
    const result = fn.apply(context, args)

    // i.e. a generator function returns an iterator
    if (is.iterator(result)) {
      return result
    }

    let resolved = false

    const next = arg => {
      if (!resolved) {
        resolved = true
        // Only promises returned from fork will be interpreted. See #1573
        // bm: 感觉这里 done 的处理没必要呀, 这个 fn 要不返回 promise, 要不常规 value
        // 在 fork context 下, 这个函数都已经执行完, 没必要等返回的 value resolve 呀
        // 因为不可能有外面的函数等待 promise resolve 毕竟这个是fork下面的 root saga.
        return { value: result, done: !is.promise(result) }
      } else {
        // once fn resolved, it return what it been passed
        return { value: arg, done: true }
      }
    }

    return makeIterator(next)
  } catch (err) {
    // do not bubble up synchronous failures for detached forks
    // instead create a failed task. See #152 and #441
    return makeIterator(() => {
      throw err
    })
  }
}

function runPutEffect(env, { channel, action, resolve }, cb) {
  /**
   Schedule the put in case another saga is holding a lock.
   The put will be executed atomically. ie nested puts will execute after
   this put has terminated.
   **/
  //
  asap(() => {
    let result
    try {
      // put into channel or redux dispatch
      result = (channel ? channel.put : env.dispatch)(action)
    } catch (error) {
      cb(error, true)
      return
    }

    if (resolve && is.promise(result)) {
      resolvePromise(result, cb)
    } else {
      cb(result)
    }
  })
  // Put effects are non cancellables
}

/**
 * 
 * @param {*} env 
 * @param {*} param1 
 *  - channel
 *  - pattern
 *  - maybe: boolean, define how cb should behave when END is received
 * @param {*} cb: (result | error, isError), 
 */
function runTakeEffect(env, { channel = env.channel, pattern, maybe }, cb) {
  const takeCb = input => {
    if (input instanceof Error) {
      // task's next
      cb(input, true)
      return
    }
    // when channel is closed or empty, an END result is emit.
    if (isEnd(input) && !maybe) {
      cb(TERMINATE)
      return
    }
    cb(input)
  }

  try {
    channel.take(takeCb, is.notUndef(pattern) ? matcher(pattern) : null)
  } catch (err) {
    cb(err, true)
    return
  }
  // takeCb.cancel is injected when been called with channel.take
  cb.cancel = takeCb.cancel
}

function runCallEffect(env, { context, fn, args }, cb, { task }) {
  // catch synchronous failures; see #152
  try {
    const result = fn.apply(context, args)

    if (is.promise(result)) {
      resolvePromise(result, cb)
      return
    }

    if (is.iterator(result)) {
      // resolve iterator
      proc(env, result, task.context, currentEffectId, getMetaInfo(fn), /* isRoot */ false, cb)
      return
    }

    cb(result)
  } catch (error) {
    cb(error, true)
  }
}

function runCPSEffect(env, { context, fn, args }, cb) {
  // CPS (ie node style functions) can define their own cancellation logic
  // by setting cancel field on the cb

  // catch synchronous failures; see #152
  try {
    const cpsCb = (err, res) => {
      if (is.undef(err)) {
        cb(res)
      } else {
        cb(err, true)
      }
    }

    fn.apply(context, args.concat(cpsCb))

    // 这个位置.cancel 只能由 fn 函数来注入了.
    if (cpsCb.cancel) {
      cb.cancel = cpsCb.cancel
    }
  } catch (error) {
    cb(error, true)
  }
}

/**
 * 
 * @param {*} env 
 * @param {*} param1 
 * @param {*} cb: (task)=> void, take a child task
 * @param {*} param3 
 *  - task, newTask.js 创建出来的对象
 */
function runForkEffect(env, { context, fn, args, detached }, cb, { task: parent }) {
  const taskIterator = createTaskIterator({ context, fn, args })
  const meta = getIteratorMetaInfo(taskIterator, fn)

  immediately(() => {
    // return child task
    const child = proc(env, taskIterator, parent.context, currentEffectId, meta, detached, undefined)

    if (detached) {
      cb(child)
    } else {
      if (child.isRunning()) {
        parent.queue.addTask(child)
        cb(child)
      } else if (child.isAborted()) {
        // bubble up
        parent.queue.abort(child.error())
      } else {
        // cancel or complete
        cb(child)
      }
    }
  })
  // Fork effects are non cancellables
}

function runJoinEffect(env, taskOrTasks, cb, { task }) {
  const joinSingleTask = (taskToJoin, cb) => {
    if (taskToJoin.isRunning()) {
      const joiner = { task, cb }
      cb.cancel = () => {
        // 默认 task 被创建出来就是 running state
        // 注意这个地方, 子任务虽然移除了parent joiner, 但是没有减掉对应的 completion count
        // 冷不丁看起来像是个bug, 但是细想想好想 子任务 如果 cancel 的话, parent task 一定被 cancel
        // 掉, 那么就没那么重要了
        if (taskToJoin.isRunning()) remove(taskToJoin.joiners, joiner)
      }
      taskToJoin.joiners.push(joiner)
    } else {
      if (taskToJoin.isAborted()) {
        cb(taskToJoin.error(), true)
      } else {
        cb(taskToJoin.result())
      }
    }
  }

  if (is.array(taskOrTasks)) {
    if (taskOrTasks.length === 0) {
      cb([])
      return
    }

    const childCallbacks = createAllStyleChildCallbacks(taskOrTasks, cb)
    taskOrTasks.forEach((t, i) => {
      joinSingleTask(t, childCallbacks[i])
    })
  } else {
    joinSingleTask(taskOrTasks, cb)
  }
}

function cancelSingleTask(taskToCancel) {
  if (taskToCancel.isRunning()) {
    taskToCancel.cancel()
  }
}

function runCancelEffect(env, taskOrTasks, cb, { task }) {
  // 默认 cancel 就是 cancel 自己, 即 task, 在io.js中有描述
  if (taskOrTasks === SELF_CANCELLATION) {
    cancelSingleTask(task)
  } else if (is.array(taskOrTasks)) {
    taskOrTasks.forEach(cancelSingleTask)
  } else {
    cancelSingleTask(taskOrTasks)
  }
  // so it basically dont care if sub cancel task actully succeed. (it tasks are async ones)
  cb()

  // cancel effects are non cancellables
}

function runAllEffect(env, effects, cb, { digestEffect }) {
  const effectId = currentEffectId
  const keys = Object.keys(effects)
  if (keys.length === 0) {
    cb(is.array(effects) ? [] : {})
    return
  }

  const childCallbacks = createAllStyleChildCallbacks(effects, cb)
  keys.forEach(key => {
    digestEffect(effects[key], effectId, childCallbacks[key], key)
  })
}

// race all effects
function runRaceEffect(env, effects, cb, { digestEffect }) {
  const effectId = currentEffectId
  const keys = Object.keys(effects)
  const response = is.array(effects) ? createEmptyArray(keys.length) : {}
  const childCbs = {}
  let completed = false

  keys.forEach(key => {
    const chCbAtKey = (res, isErr) => {
      if (completed) {
        return
      }
      // task cancel or terminated or error
      if (isErr || shouldComplete(res)) {
        // Race Auto cancellation
        cb.cancel()
        cb(res, isErr)
      } else {
        // see `cb.cancel` down below, cancel all no-terminated tasks
        cb.cancel()
        completed = true
        response[key] = res
        cb(response)
      }
    }
    chCbAtKey.cancel = noop
    childCbs[key] = chCbAtKey
  })

  cb.cancel = () => {
    // prevents unnecessary cancellation
    if (!completed) {
      completed = true
      keys.forEach(key => childCbs[key].cancel())
    }
  }

  keys.forEach(key => {
    if (completed) {
      return
    }
    digestEffect(effects[key], effectId, childCbs[key], key)
  })
}

function runSelectEffect(env, { selector, args }, cb) {
  try {
    const state = selector(env.getState(), ...args)
    cb(state)
  } catch (error) {
    cb(error, true)
  }
}

function runChannelEffect(env, { pattern, buffer }, cb) {
  const chan = channel(buffer)
  const match = matcher(pattern)

  // 从 env.channel 拿到 action, 重新注册自己, 再放到 chan 中
  const taker = action => {
    if (!isEnd(action)) {
      // register, once this taker is invoked, 
      // this taker will be removed first,
      // then invoked, which would register itself again into env.channel
      // !note, that env.channel vs chan
      env.channel.take(taker, match)
    }
    chan.put(action)
  }

  const { close } = chan

  chan.close = () => {
    // remove taker from channel's subscriber queue
    taker.cancel()
    close()
  }

  env.channel.take(taker, match)

  // return this chan to `yield` result
  cb(chan)
}

// return whether this task is cancelled
function runCancelledEffect(env, data, cb, { task }) {
  cb(task.isCancelled())
}

// clear flush items in channel
function runFlushEffect(env, channel, cb) {
  channel.flush(cb)
}

function runGetContextEffect(env, prop, cb, { task }) {
  cb(task.context[prop])
}

function runSetContextEffect(env, props, cb, { task }) {
  assignWithSymbols(task.context, props)
  cb()
}

const effectRunnerMap = {
  [effectTypes.TAKE]: runTakeEffect,
  [effectTypes.PUT]: runPutEffect,
  [effectTypes.ALL]: runAllEffect,
  [effectTypes.RACE]: runRaceEffect,
  [effectTypes.CALL]: runCallEffect,
  [effectTypes.CPS]: runCPSEffect,
  [effectTypes.FORK]: runForkEffect,
  [effectTypes.JOIN]: runJoinEffect,
  [effectTypes.CANCEL]: runCancelEffect,
  [effectTypes.SELECT]: runSelectEffect,
  [effectTypes.ACTION_CHANNEL]: runChannelEffect,
  [effectTypes.CANCELLED]: runCancelledEffect,
  [effectTypes.FLUSH]: runFlushEffect,
  [effectTypes.GET_CONTEXT]: runGetContextEffect,
  [effectTypes.SET_CONTEXT]: runSetContextEffect,
}

export default effectRunnerMap
