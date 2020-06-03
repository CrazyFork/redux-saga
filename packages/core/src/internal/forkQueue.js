import { noop, remove } from './utils'

/**
 Used to track a parent task and its forks
 In the fork model, forked tasks are attached by default to their parent
 We model this using the concept of Parent task && main Task
 main task is the main flow of the current Generator, the parent tasks is the
 aggregation of the main tasks + all its forked tasks.
 Thus the whole model represents an execution tree with multiple branches (vs the
 linear execution tree in sequential (non parallel) programming)

 A parent tasks has the following semantics
 - It completes if all its forks either complete or all cancelled
 - If it's cancelled, all forks are cancelled as well
 - It aborts if any uncaught error bubbles up from forks
 - If it completes, the return value is the one returned by the main task
 **/
/**
 * 
 * @param {*} mainTask, mainTask for this forkQueue
 * @param {*} onAbort, if this forkQueue been abort due to some error
 * @param {*} cont , cont: (any|error, hasError: boolean)=> any, only when all child fork tasks are done
 */
export default function forkQueue(mainTask, onAbort, cont) {
  let tasks = []
  let result
  let completed = false

  addTask(mainTask)
  const getTasks = () => tasks

  function abort(err) {
    onAbort()
    cancelAll()
    cont(err, true)
  }

  function addTask(task) {
    tasks.push(task)
    task.cont = (res, isErr) => {
      if (completed) {
        return
      }
      // remove this task
      remove(tasks, task)
      task.cont = noop
      if (isErr) {
        // abort all parents
        abort(res)
      } else {
        if (task === mainTask) {
          result = res
        }
        // if all tasks done
        if (!tasks.length) {
          completed = true
          cont(result)
        }
      }
    }
  }

  function cancelAll() {
    if (completed) {
      return
    }
    completed = true
    // call each tasks' cancel method
    tasks.forEach(t => {
      t.cont = noop
      t.cancel()
    })
    tasks = []
  }

  return {
    // add a task to this forked task queue
    addTask,
    // cancel all tasks
    cancelAll,
    // abort this forkQueue 
    abort,
    // get all tasks for this forkQueue, include the main one
    getTasks,
  }
}
