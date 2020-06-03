import * as is from '@redux-saga/is'
import { makeIterator } from '../utils'

const done = value => ({ done: true, value })
export const qEnd = {}

export function safeName(patternOrChannel) {
  if (is.channel(patternOrChannel)) {
    return 'channel'
  }

  if (is.stringableFunc(patternOrChannel)) {
    return String(patternOrChannel)
  }

  if (is.func(patternOrChannel)) {
    return patternOrChannel.name
  }

  return String(patternOrChannel)
}

// fsm, Finite State Machine
// return a iterator of a fms
export default function fsmIterator(fsm, startState, name) {
  let stateUpdater, // F(state), function return next state
    errorState, // pointer of fsm object which handles error on next state
    effect, // current effect to return ?
    nextState = startState // next state

  function next(arg, error) {
    if (nextState === qEnd) {
      return done(arg)
    }
    if (error && !errorState) {
      nextState = qEnd
      throw error
    } else {
      stateUpdater && stateUpdater(arg)
      const currentState = error ? fsm[errorState](error) : fsm[nextState]()
      ;({ nextState, effect, stateUpdater, errorState } = currentState)
      return nextState === qEnd ? done(arg) : effect
    }
  }

  return makeIterator(next, error => next(null, error), name)
}
