import fsmIterator, { safeName } from './fsmIterator'
import { delay, fork, race, take } from '../io'

// debounce 的语义就是拿到第一个 action, 然后等待 delayLength 之后执行对应的 action
// 和 takeLatest 的语义刚好相反, debounce 触发的是最旧的 action
export default function debounceHelper(delayLength, patternOrChannel, worker, ...args) {
  let action, raceOutput

  const yTake = { done: false, value: take(patternOrChannel) }
  const yRace = {
    done: false,
    value: race({
      action: take(patternOrChannel),
      debounce: delay(delayLength),
    }),
  }
  const yFork = ac => ({ done: false, value: fork(worker, ...args, ac) })
  const yNoop = value => ({ done: false, value })

  const setAction = ac => (action = ac)
  const setRaceOutput = ro => (raceOutput = ro)

  /*
  q1-> q2 -> q3

  q3 -> if debounce -> q1
     -> else -> q2
  */
  return fsmIterator(
    {
      q1() {
        // take a object out of channel (effect) then record next action (stateUpdater)
        // then move to state q2
        return { nextState: 'q2', effect: yTake, stateUpdater: setAction }
      },
      q2() {
        // take a object out of channel (effect) then record next race result (stateUpdater)
        // then move to state q3
        return { nextState: 'q3', effect: yRace, stateUpdater: setRaceOutput }
      },
      q3() {
        // if debounce is faster, 这步表明 delayLength 时间已经过去了
        return raceOutput.debounce
          // 执行上次缓存的 action
          ? { nextState: 'q1', effect: yFork(action) }
          // 这个地方的 setAction 不重要, 重要的是 q1 的 setAction. 这行的语义就是继续去 race.
          // 然后会新生成 delayLength. 直到在 delayLength time span 之内 channel 中没有同样的 action
          : { nextState: 'q2', effect: yNoop(raceOutput.action), stateUpdater: setAction }
      },
    },
    'q1',
    `debounce(${safeName(patternOrChannel)}, ${worker.name})`,
  )
}
