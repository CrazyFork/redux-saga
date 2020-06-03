
# 

核心概念:

* channel
    * https://redux-saga.js.org/docs/advanced/Channels.html
        * 可以创建 external source 来 tick event
        * 可以创建一个 Producer 和 worker 的模式, fork 3 worker saga and 1 producer saga.
        * 
* fork 
    * https://redux-saga.js.org/docs/advanced/ForkModel.html


```
packages/core/src
├── effects.js
├── index.js
└── internal
    ├── buffers.js                          # 实现了一个 ring buffer
    ├── channel.js                          # 实现了3中 channel, channel <- eventChannel 会缓存消息, multicastChannel 不会缓存消息, 但可以同时触发多个类型taker的回调, stdChannel <- multicastChannel
    ├── channels-trans-table.png
    ├── effectRunnerMap.js
    ├── effectTypes.js                      # saga 所能支持的 effects 类型
    ├── forkQueue.js                        # 用来实现一个 forkQueue, 即: 主任务 + child fork 出来的任务的集合
    ├── io-helpers.js                       # io 相关的工具类方法
    ├── io.js                               # 所有 IO 语义的描述, 实现在sagaHelpers里边
    ├── matcher.js                          # create a matcher
    ├── middleware.js
    ├── newTask.js                          
    ├── proc.js
    ├── resolvePromise.js
    ├── runSaga.js                          # 用来执行 saga 的, 底层会调用 ./proc
    ├── sagaError.js
    ├── sagaHelpers                         # 定义了状态机对每一种语义进行了实现
    │   ├── debounce.js
    │   ├── fsmIterator.js                  # 核心状态机, FiniteStateMachine 的定义, 转成了 generator 的形式
    │   ├── index.js
    │   ├── retry.js
    │   ├── takeEvery.js
    │   ├── takeLatest.js
    │   ├── takeLeading.js
    │   └── throttle.js
    ├── scheduler.js                        # 用来执行 tasks 的, 不知道 semaphore 是做啥用的 :(
    ├── task-status.js                      # 记录 task 的状态, RUNNING = 0, CANCELLED = 1, ABORTED = 2, DONE = 3
    ├── uid.js                              # generate UID
    └── utils.js                            # 工具类
```





# @redux-saga/core

See our [website](https://redux-saga.js.org/) for more information.

