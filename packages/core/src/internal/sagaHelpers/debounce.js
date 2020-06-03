import fsmIterator, { safeName } from './fsmIterator'
import { delay, fork, race, take } from '../io'

// :todo, why debounce doesnt has a error state
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
        // if debounce is faster then we move next value out of channel (which is state q1)
        // 
        return raceOutput.debounce
          ? { nextState: 'q1', effect: yFork(action) }
          : { nextState: 'q2', effect: yNoop(raceOutput.action), stateUpdater: setAction }
      },
    },
    'q1',
    `debounce(${safeName(patternOrChannel)}, ${worker.name})`,
  )
}
