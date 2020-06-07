import deferred from '@redux-saga/deferred'
import * as is from '@redux-saga/is'
import { TASK, TASK_CANCEL } from '@redux-saga/symbols'
import { RUNNING, CANCELLED, ABORTED, DONE } from './task-status'
import { assignWithSymbols, check, createSetContextWarning, noop } from './utils'
import forkQueue from './forkQueue'
import * as sagaError from './sagaError'

/**
 * 
 * @param {*} env,              , same env inside ./proc.js
 * @param {*} mainTask          , 
 * @param {*} parentContext     , same env inside ./proc.js
 * @param {*} parentEffectId    , same env inside ./proc.js
 * @param {*} meta              , same env inside ./proc.js
 * @param {*} isRoot            , same env inside ./proc.js
 * @param {*} cont 
 */
export default function newTask(env, mainTask, parentContext, parentEffectId, meta, isRoot, cont = noop) {
  /*
  RUNNING, CANCELLED, ABORTED, DONE
  */
  let status = RUNNING
  let taskResult
  let taskError
  let deferredEnd = null

  // array record all aborted tasks for this mainTasks
  const cancelledDueToErrorTasks = []

  const context = Object.create(parentContext)
  const queue = forkQueue(
    mainTask,
    function onAbort() {
      cancelledDueToErrorTasks.push(...queue.getTasks().map(t => t.meta.name))
    },
    // when all tasks inside this forkQueue completes, return mainTask result back
    end,
  )

  /**
   This may be called by a parent generator to trigger/propagate cancellation
   cancel all pending tasks (including the main task), then end the current task.

   Cancellation propagates down to the whole execution tree held by this Parent task
   It's also propagated to all joiners of this task and their execution tree/joiners

   Cancellation is noop for terminated/Cancelled tasks tasks
   **/
  function cancel() {
    if (status === RUNNING) {
      // Setting status to CANCELLED does not necessarily mean that the task/iterators are stopped
      // effects in the iterator's finally block will still be executed
      status = CANCELLED
      queue.cancelAll()
      // Ending with a TASK_CANCEL will propagate the Cancellation to all joiners
      end(TASK_CANCEL, false)
    }
  }


  function end(result, isErr) {
    if (!isErr) {
      // The status here may be RUNNING or CANCELLED
      // If the status is CANCELLED, then we do not need to change it here
      if (result === TASK_CANCEL) {
        status = CANCELLED
      } else if (status !== CANCELLED) {
        status = DONE
      }
      taskResult = result
      deferredEnd && deferredEnd.resolve(result)
    } else {
      // when error occurs only this task is marked ABORTED
      status = ABORTED
      sagaError.addSagaFrame({ meta, cancelledTasks: cancelledDueToErrorTasks })

      // why only root saga need this error report?
      // because any error would propogate up. so it only need to do it here once
      if (task.isRoot) {
        const sagaStack = sagaError.toString()
        // we've dumped the saga stack to string and are passing it to user's code
        // we know that it won't be needed anymore and we need to clear it
        sagaError.clear()
        env.onError(result, { sagaStack })
      }
      taskError = result
      deferredEnd && deferredEnd.reject(result)
    }

    task.cont(result, isErr)

    // notify all its parents
    task.joiners.forEach(joiner => {
      joiner.cb(result, isErr)
    })

    task.joiners = null
  }

  function setContext(props) {
    if (process.env.NODE_ENV !== 'production') {
      check(props, is.object, createSetContextWarning('task', props))
    }

    assignWithSymbols(context, props)
  }

  // toPromise 原来是这么实现的
  function toPromise() {
    if (deferredEnd) {
      return deferredEnd.promise
    }
    /*
    deferred()=> {
      promise,
      resolve,
      reject
    }
    */
    deferredEnd = deferred()

    if (status === ABORTED) {
      deferredEnd.reject(taskError)
    } else if (status !== RUNNING) {
      deferredEnd.resolve(taskResult)
    }

    return deferredEnd.promise
  }

  const task = {
    // -- starts: fields
    // 
    [TASK]: true,
    // 
    id: parentEffectId,
    // 
    meta,
    //
    isRoot,

    // this task's context, derived from parent's context
    context,
    // sub tasks
    // shape of { task, cb }, task, cb all parent task's fields, 
    // (strictly speaking in joined case cb is one of many subroutines of its parent's callback)
    // record joined parent, it make sense since it needs to notify 
    // all its parents about its final state
    joiners: [],

    // forkQueue associate with this task
    queue,

    // -- ends: fields

    // methods

    // cancel this task, especially the forkQueue, result would be a cancel result
    cancel,

    // 
    cont,

    // end this task with specified result
    end,

    // override context fields
    setContext,
    // return a promise for this task
    toPromise,

    isRunning: () => status === RUNNING,

    /*
      This method is used both for answering the cancellation status of the task and answering for CANCELLED effects.
      In most cases, the cancellation of a task propagates to all its unfinished children (including
      all forked tasks and the mainTask), so a naive implementation of this method would be:
        `() => status === CANCELLED || mainTask.status === CANCELLED`

      But there are cases that the task is aborted by an error and the abortion caused the mainTask to be cancelled.
      In such cases, the task is supposed to be aborted rather than cancelled, however the above naive implementation
      would return true for `task.isCancelled()`. So we need make sure that the task is running before accessing
      mainTask.status.

      There are cases that the task is cancelled when the mainTask is done (the task is waiting for forked children
      when cancellation occurs). In such cases, you may wonder `yield io.cancelled()` would return true because
      `status === CANCELLED` holds, and which is wrong. However, after the mainTask is done, the iterator cannot yield
      any further effects, so we can ignore such cases.

      See discussions in #1704
     */
    // :?, figure this out
    isCancelled: () => status === CANCELLED || (status === RUNNING && mainTask.status === CANCELLED),
    isAborted: () => status === ABORTED,

    result: () => taskResult,
    error: () => taskError,
  }

  return task
}
