/**
这个 scheduler 相对来说比较简单. 核心的语义就是 如果 semaphore > 0 则 asap 这个方法只记录, 不执行任务.
而 immediately 是表示立即执行当前任务, 并 flush 掉剩下的任务. since js 没有多线程. 我清楚这样的语义是什么.
就目前看 task 也不是支持异步的那种. 除非task是一个允许异步的. 但如此的话 release的语义就会很乖

核心的入口函数

- asap()
- immediately()
 */

const queue = []
/**
  Variable to hold a counting semaphore
  - Incrementing adds a lock and puts the scheduler in a `suspended` state (if it's not
    already suspended)
  - Decrementing releases a lock. Zero locks puts the scheduler in a `released` state. This
    triggers flushing the queued tasks.
**/
let semaphore = 0

/**
  Executes a task 'atomically'. Tasks scheduled during this execution will be queued
  and flushed after this task has finished (assuming the scheduler endup in a released
  state).
**/
function exec(task) {
  try {
    suspend()
    task()
  } finally {
    release()
  }
}

/**
  Executes or queues a task depending on the state of the scheduler (`suspended` or `released`)
**/
// schedule a task, run as soon as possible
export function asap(task) {
  queue.push(task)

  // only semaphore is 0, flush all remaining tasks including this one
  if (!semaphore) {
    suspend()
    flush()
  }
}

/**
 * Puts the scheduler in a `suspended` state and executes a task immediately.
 */
// 立即执行这个task, 并返回结果
export function immediately(task) {
  try {
    suspend()
    return task()
  } finally {
    flush()
  }
}

/**
  Puts the scheduler in a `suspended` state. Scheduled tasks will be queued until the
  scheduler is released.
**/
function suspend() {
  semaphore++
}

/**
  Puts the scheduler in a `released` state.
**/
function release() {
  semaphore--
}

/**
  Releases the current lock. Executes all queued tasks if the scheduler is in the released state.
**/
// 在调用这个函数之前必须先 suspend()
function flush() {
  release()

  let task
  while (!semaphore && (task = queue.shift()) !== undefined) {
    exec(task)
  }
}
