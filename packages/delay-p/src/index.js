import { CANCEL } from '@redux-saga/symbols'

/**
 * 
 * @param {*} ms 
 * @param {*} val , default value to yield
 */
export default function delayP(ms, val = true) {
  let timeoutId
  const promise = new Promise(resolve => {
    timeoutId = setTimeout(resolve, ms, val)
  })

  promise[CANCEL] = () => {
    clearTimeout(timeoutId)
  }

  return promise
}
