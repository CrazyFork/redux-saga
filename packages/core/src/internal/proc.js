import * as is from '@redux-saga/is'
import { IO, TASK_CANCEL } from '@redux-saga/symbols'
import { RUNNING, CANCELLED, ABORTED, DONE } from './task-status'
import effectRunnerMap from './effectRunnerMap'
import resolvePromise from './resolvePromise'
import nextEffectId from './uid'
import { asyncIteratorSymbol, noop, shouldCancel, shouldTerminate } from './utils'
import newTask from './newTask'
import * as sagaError from './sagaError'

/**
 * all params are describe in runSaga.js file
 * @param {*} env ,           env
 * @param {*} iterator        main saga iterator
 * @param {*} parentContext   parentContext
 * @param {*} parentEffectId  parentEffectId
 * @param {*} meta            {name: string, location}
 * @param {*} isRoot          is a root saga
 * @param {*} cont            (result|error, hasError: boolean)
 *            - cont.cancel
 */
export default function proc(env, iterator, parentContext, parentEffectId, meta, isRoot, cont) {
  if (process.env.NODE_ENV !== 'production' && iterator[asyncIteratorSymbol]) {
    throw new Error("redux-saga doesn't support async generators, please use only regular ones")
  }

  // 默认 finalRunEffect 就是 runEffect 
  const finalRunEffect = env.finalizeRunEffect(runEffect)

  /**
    Tracks the current effect cancellation
    Each time the generator progresses. calling runEffect will set a new value
    on it. It allows propagating cancellation to child effects
  **/
  next.cancel = noop

  /** Creates a main task to track the main flow */
  const mainTask = { meta, cancel: cancelMain, status: RUNNING }

  /**
   Creates a new task descriptor for this generator.
   A task is the aggregation of it's mainTask and all it's forked tasks.
   **/
  const task = newTask(env, mainTask, parentContext, parentEffectId, meta, isRoot, cont)

  const executingContext = {
    task,
    digestEffect,
  }

  // cancellation of the main task. We'll simply resume the Generator with a TASK_CANCEL
  // main task cancel would only cancel the current running one effect, since when a effect
  // starts to run, next.cancel can be set then. so it make sense only to cancel current running
  // effect then the whole task is canceled.
  function cancelMain() {
    if (mainTask.status === RUNNING) {
      mainTask.status = CANCELLED
      next(TASK_CANCEL)
    }
  }

  /**
    attaches cancellation logic to this task's continuation
    this will permit cancellation to propagate down the call chain
  **/
  if (cont) {
    cont.cancel = task.cancel
  }

  // kicks up the generator
  next()

  // then return the task descriptor to the caller
  return task

  /**
   * This is the generator driver
   * It's a recursive async/continuation function which calls itself
   * until the generator terminates or throws
   * @param {internal commands(TASK_CANCEL | TERMINATE) | any} arg - value, generator will be resumed with.
   * @param {boolean} isErr - the flag shows if effect finished with an error
   *
   * receives either (command | effect result, false) or (any thrown thing, true)
   */
  function next(arg, isErr) {
    try {
      let result
      if (isErr) {
        result = iterator.throw(arg)
        // user handled the error, we can clear bookkept values
        sagaError.clear()
      } else if (shouldCancel(arg)) {
        /**
          getting TASK_CANCEL automatically cancels the main task
          We can get this value here

          - By cancelling the parent task manually
          - By joining a Cancelled task
        **/
        mainTask.status = CANCELLED
        /**
          Cancels the current effect; this will propagate the cancellation down to any called tasks
        **/
        next.cancel()

        /**
          If this Generator has a `return` method then invokes it
          This will jump to the finally block
        **/
        // bm: what this iterator.return means?
        // terminate this iterator with TASK_CANCEL value
        result = is.func(iterator.return) ? iterator.return(TASK_CANCEL) : { done: true, value: TASK_CANCEL }
      } else if (shouldTerminate(arg)) {
        // We get TERMINATE flag, i.e. by taking from a channel that ended using `take` (and not `takem` used to trap End of channels)
        result = is.func(iterator.return) ? iterator.return() : { done: true }
      } else {
        result = iterator.next(arg)
      }

      if (!result.done) {
        // internally this function would call recursivelly `runEffect` which would call 
        // corrsponding effectRunner which would call next(result, false) if done, 
        // or next(error, true) should any error occur
        digestEffect(result.value, parentEffectId, next)
      } else {
        /**
          This Generator has ended, terminate the main task and notify the fork queue
        **/
        if (mainTask.status !== CANCELLED) {
          mainTask.status = DONE
        }
        mainTask.cont(result.value)
      }
    } catch (error) {
      if (mainTask.status === CANCELLED) {
        throw error
      }
      mainTask.status = ABORTED

      mainTask.cont(error, true)
    }
  }

  /**
   * 这个函数估计是定义了如何执行 effect. 可以看到不同类型的 effect, user code 可以定义 cancel 的逻辑, 然后
   * generator 在run 的时候可以调用对应的 cancel 代码. 具体看下面注释
   *  - promise, promise[CANCEL]
   *  - cb, 需要在 cb.cancel 上 attach cancel 逻辑
   * 
   * IO effect 由 effectRunner 来执行.
   * 
   * @param {*} effect 
   * @param {*} effectId 
   * @param {*} currCb 
   */
  function runEffect(effect, effectId, currCb) {
    /**
      each effect runner must attach its own logic of cancellation to the provided callback
      it allows this generator to propagate cancellation downward.

      ATTENTION! effect runners must setup the cancel logic by setting cb.cancel = [cancelMethod]
      And the setup must occur before calling the callback

      This is a sort of inversion of control: called async functions are responsible
      of completing the flow by calling the provided continuation; while caller functions
      are responsible for aborting the current flow by calling the attached cancel function

      Library users can attach their own cancellation logic to promises by defining a
      promise[CANCEL] method in their returned promises
      ATTENTION! calling cancel must have no effect on an already completed or cancelled effect
    **/

    // 这里边会设置 currCb.cancel 该如何 cancel. 其实想想也合理, 既然effectRunner 定义了 effect 该如何执行
    // 那么就应该又 effectRunner 来决定如何取消
    if (is.promise(effect)) {
      resolvePromise(effect, currCb)
    } else if (is.iterator(effect)) {
      // yield saga() 返回的是 generator, 也就是这种会单独生成 task
      // yield* saga() 返回的是不同的 effect.
      // resolve iterator
      proc(env, effect, task.context, effectId, meta, /* isRoot */ false, currCb)
    } else if (effect && effect[IO]) {        // saga 内置的 effect
      const effectRunner = effectRunnerMap[effect.type]
      effectRunner(env, effect.payload, currCb, executingContext)
    } else {
      // anything else returned as is
      currCb(effect)
    }
  }

  /**
   * 这个函数对原有的 cb 进行了 cancel & end (including error) 两种状态的劫持, 就是为了注入 sagaMonitor.
   * 最终会运行这个 effect.
   * @param {*} effect            , effect to be run
   * @param {*} parentEffectId    , parent effect id
   * @param {*} cb                , completion callback 
   * @param {*} label             , label
   */
  function digestEffect(effect, parentEffectId, cb, label = '') {
    const effectId = nextEffectId()
    env.sagaMonitor && env.sagaMonitor.effectTriggered({ effectId, parentEffectId, label, effect })

    /**
      completion callback and cancel callback are mutually exclusive
      We can't cancel an already completed effect
      And We can't complete an already cancelled effectId
    **/
    // indicated whether this task reaches its final state
    let effectSettled

    // create new callback to hijack cb
    // Completion callback passed to the appropriate effect runner
    function currCb(res, isErr) {
      if (effectSettled) {
        return
      }

      effectSettled = true
      cb.cancel = noop // defensive measure
      if (env.sagaMonitor) {
        if (isErr) {
          env.sagaMonitor.effectRejected(effectId, res)
        } else {
          env.sagaMonitor.effectResolved(effectId, res)
        }
      }

      if (isErr) {
        sagaError.setCrashedEffect(effect)
      }

      cb(res, isErr)
    }

    // tracks down the current cancel
    // it's basically useless
    currCb.cancel = noop

    // link original cb's cancel to this currCb
    // setup cancellation logic on the parent cb
    cb.cancel = () => {
      // prevents cancelling an already completed effect
      if (effectSettled) {
        return
      }

      effectSettled = true

      currCb.cancel() // propagates cancel downward
      currCb.cancel = noop // defensive measure

      env.sagaMonitor && env.sagaMonitor.effectCancelled(effectId)
    }

    // run saga io effects
    finalRunEffect(effect, effectId, currCb)
  }
}
