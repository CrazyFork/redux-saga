import * as is from '@redux-saga/is'
import { CHANNEL_END_TYPE, MATCH, MULTICAST, SAGA_ACTION } from '@redux-saga/symbols'
import { check, remove, once, internalErr } from './utils'
import * as buffers from './buffers'
import { asap } from './scheduler'
import * as matchers from './matcher'

export const END = { type: CHANNEL_END_TYPE }
export const isEnd = a => a && a.type === CHANNEL_END_TYPE

const CLOSED_CHANNEL_WITH_TAKERS = 'Cannot have a closed channel with pending takers'
const INVALID_BUFFER = 'invalid buffer passed to channel factory function'
const UNDEFINED_INPUT_ERROR = `Saga or channel was provided with an undefined action
Hints:
  - check that your Action Creator returns a non-undefined value
  - if the Saga was started using runSaga, check that your subscribe source provides the action to its listeners`


// 这个函数实现了一个channel, 
// * consumer will invoke once, then remove from subscriber's queue
// * if event hasnt yet come, then this subscriber would be push to listener queue
// 底层的 buffer 用来缓冲消息.
export function channel(buffer = buffers.expanding()) {
  let closed = false
  let takers = []

  if (process.env.NODE_ENV !== 'production') {
    check(buffer, is.buffer, INVALID_BUFFER)
  }

  // takers 如果为空 buffer 里边不可能为空
  // closed channel taker 必然为空
  function checkForbiddenStates() {
    if (closed && takers.length) {
      throw internalErr(CLOSED_CHANNEL_WITH_TAKERS)
    }
    if (takers.length && !buffer.isEmpty()) {
      throw internalErr('Cannot have pending takers with non empty buffer')
    }
  }

  function put(input) {
    if (process.env.NODE_ENV !== 'production') {
      checkForbiddenStates()
      check(input, is.notUndef, UNDEFINED_INPUT_ERROR)
    }

    if (closed) {
      return
    }
    if (takers.length === 0) {
      return buffer.put(input)
    }
    const cb = takers.shift()
    cb(input)
  }

  function take(cb) {
    if (process.env.NODE_ENV !== 'production') {
      checkForbiddenStates()
      check(cb, is.func, "channel.take's callback must be a function")
    }

    if (closed && buffer.isEmpty()) {
      cb(END)
    } else if (!buffer.isEmpty()) {
      cb(buffer.take())
    } else {
      takers.push(cb)
      cb.cancel = () => {
        remove(takers, cb)
      }
    }
  }

  function flush(cb) {
    if (process.env.NODE_ENV !== 'production') {
      checkForbiddenStates()
      check(cb, is.func, "channel.flush' callback must be a function")
    }

    if (closed && buffer.isEmpty()) {
      cb(END)
      return
    }
    // cbj([...events])
    cb(buffer.flush())
  }

  // invariant 保证了 close 的时候 
  function close() {
    if (process.env.NODE_ENV !== 'production') {
      checkForbiddenStates()
    }

    if (closed) {
      return
    }

    closed = true

    const arr = takers
    takers = []

    for (let i = 0, len = arr.length; i < len; i++) {
      const taker = arr[i]
      taker(END)
    }
  }

  return {
    // take a message or be pushed on taker's queue
    take,
    // push a message or be consumed immediately if taker's queue not empty
    put,
    // take all message out once for all
    flush,
    // close this channel if all prerequisites meet
    close,
  }
}
 
// 这个 channel 是需要 subscribe 来 produce event. take & flush 来 consume event 
// 相当于 RxJS 的里边的概念
export function eventChannel(subscribe, buffer = buffers.none()) {
  let closed = false
  let unsubscribe

  const chan = channel(buffer)
  const close = () => {
    if (closed) {
      return
    }

    closed = true

    if (is.func(unsubscribe)) {
      unsubscribe()
    }
    chan.close()
  }

  // __tests__/channel.js
  // in test file we can see that `input` callback is an event-emiter
  // produce events & return a unsubscribe function
  unsubscribe = subscribe(input => {
    if (isEnd(input)) {
      close()
      return
    }
    chan.put(input)
  })

  if (process.env.NODE_ENV !== 'production') {
    check(unsubscribe, is.func, 'in eventChannel: subscribe should return a function to unsubscribe')
  }

  unsubscribe = once(unsubscribe)

  if (closed) {
    unsubscribe()
  }

  return {
    take: chan.take,
    flush: chan.flush,
    close,
  }
}

// 这个 channel 的特点在于不会缓存 message, if no taker is registered, then the message would be lost
// 第二个一点就是, 如果一个 input 过来, 多个 matcher 匹配, 那么对应匹配的 taker 将会接收到这个input, 并从 queue
// 中移除.
export function multicastChannel() {
  let closed = false
  // currentTakers 感觉完全没啥用呀!, 用一个 currentTakers 感觉就能满足呀.
  let currentTakers = []
  let nextTakers = currentTakers

  // if this channel closed, nextTakers.length has to be 0
  function checkForbiddenStates() {
    if (closed && nextTakers.length) {
      throw internalErr(CLOSED_CHANNEL_WITH_TAKERS)
    }
  }

  // make nextTakers a clone of currentTakers
  const ensureCanMutateNextTakers = () => {
    if (nextTakers !== currentTakers) {
      return
    }
    nextTakers = currentTakers.slice()
  }

  const close = () => {
    if (process.env.NODE_ENV !== 'production') {
      checkForbiddenStates()
    }

    closed = true
    // notify all nextTakers with an END event
    // then move all to currentTakers
    const takers = (currentTakers = nextTakers)
    nextTakers = []
    takers.forEach(taker => {
      taker(END)
    })
  }

  return {
    [MULTICAST]: true,
    // push a input into this channel. 
    // * close channel if this input is END
    // * notify all nextTakers about this new event
    put(input) {
      if (process.env.NODE_ENV !== 'production') {
        checkForbiddenStates()
        check(input, is.notUndef, UNDEFINED_INPUT_ERROR)
      }

      if (closed) {
        return
      }

      if (isEnd(input)) {
        // close will send a END event
        close()
        return
      }

      const takers = (currentTakers = nextTakers)

      for (let i = 0, len = takers.length; i < len; i++) {
        const taker = takers[i]

        // if taker matches this input, cancels priori task, then starts with new one
        if (taker[MATCH](input)) {
          taker.cancel()
          taker(input)
        }
      }
    },

    take(cb, matcher = matchers.wildcard) {
      if (process.env.NODE_ENV !== 'production') {
        checkForbiddenStates()
      }
      if (closed) {
        cb(END)
        return
      }

      cb[MATCH] = matcher
      ensureCanMutateNextTakers()
      nextTakers.push(cb)

      cb.cancel = once(() => {
        ensureCanMutateNextTakers()
        remove(nextTakers, cb)
      })
    },
    close,
  }
}

export function stdChannel() {
  const chan = multicastChannel()
  const { put } = chan
  chan.put = input => {
    // prioritize saga action ?
    if (input[SAGA_ACTION]) {
      put(input)
      return
    }
    asap(() => {
      put(input)
    })
  }
  return chan
}
