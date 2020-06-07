import fsmIterator, { safeName } from './fsmIterator'
import { take, fork, actionChannel, delay } from '../io'
import * as buffers from '../buffers'

// 这个的语义是 delayLength 时间内, 最多触发一次
export default function throttle(delayLength, pattern, worker, ...args) {
  let action, channel
  // actionChannel 这个 effect 会将 saga stdChannel 中的值拿出来写到返回的 chan 中
  // 会取最新的 action, 因为这个buffer, buffers.sliding(1)
  const yActionChannel = { done: false, value: actionChannel(pattern, buffers.sliding(1)) }
  const yTake = () => ({ done: false, value: take(channel) })
  const yFork = ac => ({ done: false, value: fork(worker, ...args, ac) })
  const yDelay = { done: false, value: delay(delayLength) }

  const setAction = ac => (action = ac)
  const setChannel = ch => (channel = ch)

  return fsmIterator(
    {
      q1() {
        return { nextState: 'q2', effect: yActionChannel, stateUpdater: setChannel }
      },
      q2() {
        return { nextState: 'q3', effect: yTake(), stateUpdater: setAction }
      },
      q3() {
        return { nextState: 'q4', effect: yFork(action) }
      },
      q4() {
        return { nextState: 'q2', effect: yDelay }
      },
    },
    'q1',
    `throttle(${safeName(pattern)}, ${worker.name})`,
  )
}
