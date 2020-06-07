import fsmIterator, { safeName } from './fsmIterator'
import { take, fork } from '../io'


export default function takeEvery(patternOrChannel, worker, ...args) {
  const yTake = { done: false, value: take(patternOrChannel) }
  // :bm why use fork here
  // 因为外层sheduler 要负责执行这个effect, 在同一个 generator 里边, 如果上一个 effect 没执行完
  // 会 block 掉下一个的 effect 的执行, 用 fork 就没有这个问题.
  const yFork = ac => ({ done: false, value: fork(worker, ...args, ac) })

  let action,
    setAction = ac => (action = ac)

  // 定义了 q1 <-> q2 的 infinite loop 
  return fsmIterator(
    {
      q1() {
        return { nextState: 'q2', effect: yTake, stateUpdater: setAction }
      },
      q2() {
        // the action variable will be set using setAction
        return { nextState: 'q1', effect: yFork(action) }
      },
    },
    'q1',
    `takeEvery(${safeName(patternOrChannel)}, ${worker.name})`,
  )
}
