// 拦截思源关闭快捷键，防止误关闭文档或误退出
//
// Linux / Windows：
//   Ctrl+W
//   - 有打开的页签：询问是否关闭当前文档
//   - 没有打开的页签：询问是否退出思源笔记
//
// Linux / Windows：Alt+F4
// macOS：Command+Q
// 窗口管理器发出的关闭请求：
//   - 询问是否退出思源笔记
//
// version 0.2.0
(() => {
    if (!isElectron()) return;

    const { ipcRenderer } = require("electron");

    /*
     * 思源主进程在收到 Alt+F4 等窗口关闭请求后，
     * 会通过这个 IPC 通道通知前端执行保存和退出。
     */
    const closeChannel = "siyuan-save-close";

    const stateKey = "__siyuanSafeCloseState__";
    const legacyKey = "__siyuanSafeCloseKeyHandler__";

    /*
     * 清理 0.1.x 版本留下的 keydown 监听器，
     * 避免更新代码片段后 Ctrl+W 重复弹窗。
     */
    if (window[legacyKey]) {
        window.removeEventListener(
            "keydown",
            window[legacyKey],
            true
        );

        delete window[legacyKey];
    }

    const previousState = window[stateKey];
    let originalCloseListeners;

    if (previousState) {
        /*
         * 当前代码片段被重新执行时，
         * 先移除上一版注册的事件监听器。
         */
        window.removeEventListener(
            "keydown",
            previousState.keydownHandler,
            true
        );

        ipcRenderer.removeListener(
            closeChannel,
            previousState.closeHandler
        );

        originalCloseListeners =
        previousState.originalCloseListeners || [];
    } else {
        /*
         * 思源自己的 siyuan-save-close 监听器会在
         * JavaScript 代码片段执行前注册。
         *
         * 先保存原监听器，确认退出后再调用，
         * 这样可以继续使用思源原生的布局保存和退出流程。
         */
        originalCloseListeners =
        ipcRenderer.listeners(closeChannel);
    }

    /*
     * 移除思源原监听器。
     *
     * 否则即使用户在确认框中选择“否”，
     * 原监听器仍会继续执行退出流程。
     */
    originalCloseListeners.forEach((listener) => {
        ipcRenderer.removeListener(
            closeChannel,
            listener
        );
    });

    let dialogOpen = false;
    let exitInProgress = false;

    /**
     * 处理 Ctrl+W。
     *
     * Alt+F4 不会进入这里，而是由下面的
     * handleWindowClose() 处理。
     */
    function handleKeydown(event) {
        const isDesktopCtrlW =
        (isLinux() || isWindows()) &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (
            event.code === "KeyW" ||
            event.key?.toLowerCase() === "w"
        );

        if (!isDesktopCtrlW) return;

        /*
         * 阻止思源原本的 Ctrl+W 页签关闭逻辑。
         */
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (
            event.repeat ||
            dialogOpen ||
            exitInProgress
        ) {
            return;
        }

        const activeTab = getActiveTabContext();

        if (activeTab.header) {
            dialogOpen = true;

            try {
                if (
                    showYesNoDialog(
                        "是否关闭当前文档？"
                    )
                ) {
                    closeActiveTab(activeTab);
                }
            } finally {
                dialogOpen = false;
            }
        } else {
            confirmAndExit();
        }
    }

    /**
     * 处理来自 Electron 主进程的窗口关闭请求。
     *
     * Linux / Windows 的 Alt+F4、
     * Linux 窗口管理器关闭请求、
     * macOS 的应用退出请求，
     * 都会进入这个事件。
     */
    function handleWindowClose(event) {
        if (
            dialogOpen ||
            exitInProgress
        ) {
            return;
        }

        confirmAndExit(event);
    }

    /**
     * 显示退出确认框。
     */
    function confirmAndExit(ipcEvent = null) {
        if (
            dialogOpen ||
            exitInProgress
        ) {
            return;
        }

        dialogOpen = true;
        let confirmed = false;

        try {
            confirmed = showYesNoDialog(
                "是否退出思源笔记？"
            );
        } finally {
            dialogOpen = false;
        }

        if (!confirmed) return;

        exitInProgress = true;
        performNativeExit(ipcEvent);
    }

    /**
     * 调用思源原本的窗口退出监听器。
     *
     * 这样可以先保存布局，再走思源自身的退出流程，
     * 而不是直接粗暴销毁 Electron 窗口。
     */
    function performNativeExit(ipcEvent) {
        if (originalCloseListeners.length > 0) {
            /*
             * 第二个参数强制传入 true。
             *
             * 思源原代码会把这个值传给 winOnClose(close)。
             * true 表示明确退出，不受“关闭按钮行为”
             * 设置中的“最小化到托盘”影响。
             */
            originalCloseListeners.forEach(
                (listener) => {
                    try {
                        listener.call(
                            ipcRenderer,
                            ipcEvent,
                            true
                        );
                    } catch (error) {
                        console.error(
                            "[思源安全关闭] " +
                            "调用思源原生退出流程失败：",
                            error
                        );
                    }
                }
            );

            return;
        }

        /*
         * 理论上正常的思源 3.7 不会走到这里。
         * 保留作为后续源码结构变化时的兼容兜底。
         */
        quitSiYuanFallback();
    }

    window.addEventListener(
        "keydown",
        handleKeydown,
        true
    );

    ipcRenderer.on(
        closeChannel,
        handleWindowClose
    );

    /*
     * 保存状态，以便代码片段被重新加载时
     * 清理旧监听器。
     */
    window[stateKey] = {
        keydownHandler: handleKeydown,
        closeHandler: handleWindowClose,
        originalCloseListeners
    };

    /**
     * 获取当前获得焦点的中心页签。
     */
    function getActiveTabContext() {
        const header =
        document.querySelector(
            '.layout__wnd--active ' +
            '[data-type="tab-header"]' +
            '.item--focus[data-id]'
        ) ||
        document.querySelector(
            '[data-type="tab-header"]' +
            '.item--focus[data-id]'
        );

        if (!header) {
            return {
                header: null,
                tab: null
            };
        }

        const tabId =
        header.getAttribute("data-id");

        return {
            header,
            tab: findInstanceById(
                tabId,
                window.siyuan?.layout?.centerLayout
            )
        };
    }

    /**
     * 根据页签 ID 递归查找布局实例。
     */
    function findInstanceById(id, item) {
        if (!id || !item) return null;

        if (item.id === id) {
            return item;
        }

        if (!Array.isArray(item.children)) {
            return null;
        }

        for (const child of item.children) {
            const result =
            findInstanceById(id, child);

            if (result) {
                return result;
            }
        }

        return null;
    }

    /**
     * 使用思源自身的 removeTab 流程
     * 关闭当前文档页签。
     */
    function closeActiveTab({ header, tab }) {
        if (
            tab?.parent &&
            typeof tab.parent.removeTab === "function"
        ) {
            tab.parent.removeTab(tab.id);
            return;
        }

        /*
         * 如果内部 Tab 实例结构发生变化，
         * 尝试点击当前页签的关闭按钮。
         */
        const closeButton =
        header?.querySelector(".item__close");

        if (closeButton) {
            closeButton.dispatchEvent(
                new MouseEvent("click", {
                    bubbles: true,
                    cancelable: true,
                    view: window
                })
            );

            return;
        }

        console.warn(
            "[思源安全关闭] " +
            "未找到当前页签实例，已取消关闭。"
        );
    }

    /**
     * 调用 Electron 原生确认对话框。
     */
    function showYesNoDialog(message) {
        try {
            const result = ipcRenderer.sendSync(
                "siyuan-confirm-dialog",
                {
                    type: "question",
                    title: "思源笔记",
                    message,
                    buttons: ["是", "否"],

                    /*
                     * 默认选择“否”，避免按回车误操作。
                     */
                    defaultId: 1,
                        cancelId: 1,

                        /*
                         * Windows 下使用普通按钮样式。
                         */
                        noLink: true
                }
            );

            /*
             * “是”是第一个按钮，索引为 0。
             */
            return result === 0;
        } catch (error) {
            console.warn(
                "[思源安全关闭] " +
                "原生确认框不可用，" +
                "回退到 window.confirm：",
                error
            );

            return window.confirm(message);
        }
    }

    /**
     * 后备退出流程。
     *
     * 仅在无法取得思源原生关闭监听器时使用。
     */
    async function quitSiYuanFallback() {
        try {
            await requestApi(
                "/api/system/exit"
            );
        } catch (error) {
            /*
             * 内核退出时可能先停止 HTTP 服务，
             * 导致 fetch 无法正常取得响应。
             */
            console.warn(
                "[思源安全关闭] " +
                "内核退出请求未正常返回，" +
                "继续关闭桌面窗口：",
                error
            );
        }

        try {
            ipcRenderer.send(
                "siyuan-quit",
                window.location.port
            );
        } catch (error) {
            exitInProgress = false;

            console.error(
                "[思源安全关闭] " +
                "无法通知 Electron 退出：",
                error
            );
        }
    }

    async function requestApi(
        url,
        data = {},
        method = "POST"
    ) {
        const response = await fetch(url, {
            method,
            headers: {
                "Content-Type":
                "application/json"
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            throw new Error(
                `${response.status} ` +
                response.statusText
            );
        }

        return response.json();
    }

    function isLinux() {
        return (
            window.siyuan
            ?.config
            ?.system
            ?.os === "linux" ||
            /Linux/i.test(navigator.platform) ||
            /Linux/i.test(navigator.userAgent)
        );
    }

    function isWindows() {
        return (
            window.siyuan
            ?.config
            ?.system
            ?.os === "windows" ||
            /Win/i.test(navigator.platform)
        );
    }

    function isElectron() {
        return navigator.userAgent.includes(
            "Electron"
        );
    }
})();
