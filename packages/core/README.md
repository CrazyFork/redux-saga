
# Redux Saga 阅读


todo:

* 和那篇文章描述的简单实现有什么差别
    * 大体原理应该是一样的, 唯独的地方是 saga 内部封装了 runtime, 可以确保任务被fork和取消. 

* lerna & rollup 的使用
    * lerna 主要是发包会自动话 npm 和 git, link multiple packages
    * rollup 感觉应该是一样的

* task 和 saga 的关系
    * 当一个 saga 执行的时候, 包括 fork, 底层会调用 proc 创建一个 mainTask 和这个 saga iterator 关联起来

* 为啥 fork 会异步执行
    * fork 底层生成了一个新的 generator, 在通过 ./proc.js 执行, 当执行异步的 effect 的时候, 对应的 effect 
        是异步的所以不会 block 当前 generator 的执行
    * 

* blocking queue 是如何在 js 中实现的
    * when take effect run, it places a callback(which is iterator's next function) inside channel
        , only when this channel been put with element this callback can then be run 

* scheduler 的作用
    * 感觉鸟作用没有呀

* read first commit
    * 

* redux middleware
    ```javascript
    const timerMiddleware = store => next => action => {
        if (action.type === 'START_TIMER') {
            action.interval = setInterval(() => store.dispatch({ type: 'TICK', currentTime: Date.now() }), 1000);
        } else if (action.type === 'STOP_TIMER') {
            clearInterval(action.interval);
        }
        // pass action to next middleware
        next(action);
    };
    ```


* doc - https://redux-saga.js.org/docs/advanced/ForkModel.html

核心概念:

* effect: 
    * 这个很重要, 所有的 take, takeLatest, put, call 等等, 都被定义成了 effect. ta 是定义了 effect 需要执行的必要参数
    * 对应有 effectRunner, 具体负责该如何执行对应的 io effect (io effect 是指这个库定义的 effect)
    * ./proc.js 中有该库的 runEffect 来负责执行所有的 saga effect.

* channel
    * https://redux-saga.js.org/docs/advanced/Channels.html
        * 可以创建 external source 来 tick event
        * 可以创建一个 Producer 和 worker 的模式, fork 3 worker saga and 1 producer saga.
        * 
    
    * channel 指令

* fork 
    * https://redux-saga.js.org/docs/advanced/ForkModel.html


* callback, 其类型为 `(result|error, isError: boolean)=> void`, 还具有一个 `cancel: ()=> void` 属性. 用来执行 cancel 逻辑. 
    * 下面这俩都是 effectRunner 返回的
        * TERMINATE, should terminate this task, common reason is channel is empty
        * TASK_CANCEL, should cancel this task

* task, 一个调度任务, 由, newTask 构建出来. 底层会用到 forkQueue.
    * 由 mainTask & subTasks 组成.
    * complete, abort, or cancelled.
    * task 的状态有: 
        * CANCELLED, DONE, ABORTED(由于执行的时候跑错), RUNNING


* proc
    * process, 和你当初声明 saga 的 iterator 是一一对应的关系.

其他:

* 这个库还是比较js 的写法的, 从来没有 class 之类的, 都是函数invoke返回一个新的 object instance, 然后通过内部的 symbol 属性来鉴别是哪种对象.




```
packages/core/src
├── effects.js                              # 没啥用, export 方法的
├── index.js
└── internal
    ├── buffers.js                          # 实现了一个 ring buffer
    ├── channel.js                          # 实现了3中 channel, channel <- eventChannel 会缓存消息, multicastChannel 不会缓存消息, 但可以同时触发多个类型taker的回调, stdChannel <- multicastChannel
    ├── effectRunnerMap.js                  # 执行 io 里边定义的 terminal io 类型.
    ├── effectTypes.js                      # saga 所能支持的 effects 类型
    ├── forkQueue.js                        # 用来实现一个 forkQueue, 即: 主任务 + child fork 出来的任务的集合
    ├── io-helpers.js                       # io 高阶的运行语义描述.
    ├── io.js                               # 所有 IO 语义的描述
    ├── matcher.js                          # create a matcher, matcher: (action)=> boolean
    ├── middleware.js                       # 提供和 redux 结合的 middleware
    ├── newTask.js                          # create a new task, internally it uses forkQueue.
    ├── proc.js                             # 执行 saga iterator 的, 真正定义了 saga 该如何执行
    ├── resolvePromise.js                   # 将 promise 转换成 saga 内部的 callback 形式
    ├── runSaga.js                          # 用来执行 saga 的, 底层会调用 ./proc
    ├── sagaError.js                        # 定义了记录 saga error 的 error frame 和 effect.
    ├── sagaHelpers                         # 定义了状态机对每一种语义进行了实现, 基本都 return 了一个 generator, 每次返回 next effect 需要执行的. 没标注的都好理解
    │   ├── debounce.js                             # 有新 action 就一直不执行, 直到没有新的 action 就将最老的 action 拿出来执行.
    │   ├── fsmIterator.js                  # 核心状态机, FiniteStateMachine 的定义, 转成了 generator 的形式
    │   ├── index.js    
    │   ├── retry.js                                # 如果失败尝试 n 次至少.
    │   ├── takeEvery.js                            # take 没一个 action
    │   ├── takeLatest.js                           # 只 take 最新的 action
    │   ├── takeLeading.js                          # 感觉和 take 没区别呀?
    │   └── throttle.js                             # happen most one time at certain timespan
    ├── scheduler.js                        # 用来执行 tasks 的, 语义只有 asap, immediately
    ├── task-status.js                      # 记录 task 的状态, RUNNING = 0, CANCELLED = 1, ABORTED = 2, DONE = 3
    ├── uid.js                              # generate UID
    └── utils.js                            # 工具类
```





# @redux-saga/core

See our [website](https://redux-saga.js.org/) for more information.

