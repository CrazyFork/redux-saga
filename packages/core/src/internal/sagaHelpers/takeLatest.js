import fsmIterator, { safeName } from './fsmIterator'
import { cancel, take, fork } from '../io'

export default function takeLatest(patternOrChannel, worker, ...args) {
  const yTake = { done: false, value: take(patternOrChannel) }
  const yFork = ac => ({ done: false, value: fork(worker, ...args, ac) })
  const yCancel = task => ({ done: false, value: cancel(task) })

  let task, action
  const setTask = t => (task = t)
  const setAction = ac => (action = ac)

  return fsmIterator(
    {
      q1() {
        return { nextState: 'q2', effect: yTake, stateUpdater: setAction }
      },
      q2() {
        return task
          // 这个地方之所以能 cancel 就是因为 fork 出来的任务在另一个 proc 里边执行
          // 可能会异步没有执行完, 因为如果执行完了的 task 对 cancel 和 takeLatest 都没有意义
          ? { nextState: 'q3', effect: yCancel(task) }
          // 这个地方很微妙, 外部的 generator runner 会根据 yFork(action) 来生成 task,
          // then it will be called with setTask. 而且一旦设置上之后, 没有任何必要将
          // cached task 置空, 因为一旦 task reachs its final state, cancel it would not 
          // have any effect.
          : { nextState: 'q1', effect: yFork(action), stateUpdater: setTask }
      },
      q3() {
        return { nextState: 'q1', effect: yFork(action), stateUpdater: setTask }
      },
    },
    'q1',
    `takeLatest(${safeName(patternOrChannel)}, ${worker.name})`,
  )
}
