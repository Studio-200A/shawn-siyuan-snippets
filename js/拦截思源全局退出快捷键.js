// 拦截思源关闭快捷键，防止误关闭文档或误退出
//
// Linux：
//   Ctrl+W
//   - 当前存在打开的页签：询问是否关闭当前文档
//   - 当前没有打开的页签：询问是否退出思源笔记
//
// macOS：Command+Q 时询问是否退出
// Windows：Alt+F4 时询问是否退出
//
// version 0.1.0
(() => {
    if (!isElectron()) return;

    /*
     * 如果片段在不重启思源的情况下被重新加载，
     * 先移除旧监听器，避免重复弹窗。
     */
    const handlerKey = "__siyuanSafeCloseKeyHandler__";

    if (window[handlerKey]) {
        window.removeEventListener(
            "keydown",
            window[handlerKey],
            true
        );
    }

    let handling = false;

    async function handleKeydown(event) {
        const isLinuxCtrlW =
        isLinux() &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (
            event.code === "KeyW" ||
            event.key?.toLowerCase() === "w"
        );

        const isMacQuit =
        isMac() &&
        event.metaKey &&
        event.code === "KeyQ" &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey;

        const isWindowsQuit =
        isWindows() &&
        event.altKey &&
        event.code === "F4" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey;

        if (
            !isLinuxCtrlW &&
            !isMacQuit &&
            !isWindowsQuit
        ) {
            return;
        }

        /*
         * 必须立即阻止思源自己的快捷键处理逻辑。
         *
         * 使用 window 捕获阶段监听，并调用
         * stopImmediatePropagation，避免确认框弹出后，
         * 原本的 Ctrl+W 仍继续关闭页签。
         */
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        // 长按快捷键或连续触发时，只处理一次。
        if (event.repeat || handling) return;

        handling = true;

        try {
            if (isLinuxCtrlW) {
                const activeTab = getActiveTabContext();

                if (activeTab.header) {
                    const confirmed = showYesNoDialog(
                        "是否关闭当前文档？"
                    );

                    if (confirmed) {
                        closeActiveTab(activeTab);
                    }
                } else {
                    const confirmed = showYesNoDialog(
                        "是否退出思源笔记？"
                    );

                    if (confirmed) {
                        await quitSiYuan();
                    }
                }

                return;
            }

            /*
             * 保留原片段的 macOS Command+Q
             * 和 Windows Alt+F4 退出确认功能。
             */
            const confirmed = showYesNoDialog(
                "是否退出思源笔记？"
            );

            if (confirmed) {
                await quitSiYuan();
            }
        } catch (error) {
            console.error(
                "[思源安全关闭] 操作失败：",
                error
            );
        } finally {
            handling = false;
        }
    }

    window[handlerKey] = handleKeydown;

    window.addEventListener(
        "keydown",
        handleKeydown,
        true
    );

    /**
     * 获取当前获得焦点的中心页签。
     *
     * 思源当前版本也是通过活动窗口中的
     * .item--focus 获取当前 Tab 实例。
     */
    function getActiveTabContext() {
        const header =
        document.querySelector(
            '.layout__wnd--active ' +
            '[data-type="tab-header"].item--focus[data-id]'
        ) ||
        document.querySelector(
            '[data-type="tab-header"].item--focus[data-id]'
        );

        if (!header) {
            return {
                header: null,
                tab: null
            };
        }

        const tabId = header.getAttribute("data-id");

        return {
            header,
            tab: findInstanceById(
                tabId,
                window.siyuan?.layout?.centerLayout
            )
        };
    }

    /**
     * 按照思源 getInstanceById 的结构，
     * 递归查找对应的布局实例。
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
            const result = findInstanceById(id, child);

            if (result) {
                return result;
            }
        }

        return null;
    }

    /**
     * 使用思源自身的 removeTab 流程关闭当前页签。
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
         * 兼容性兜底：
         * 正常情况下不会走到这里。
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
            "[思源安全关闭] 未找到当前页签实例，已取消关闭。"
        );
    }

    /**
     * 调用 Electron 原生确认对话框，
     * 明确显示“是”和“否”两个按钮。
     */
    function showYesNoDialog(message) {
        try {
            const { ipcRenderer } = require("electron");

            const result = ipcRenderer.sendSync(
                "siyuan-confirm-dialog",
                {
                    type: "question",
                    title: "思源笔记",
                    message,
                    buttons: ["是", "否"],

                    // 默认选中“否”，避免回车误操作。
                    defaultId: 1,
                        cancelId: 1,

                        // Windows 下避免按钮显示成命令链接样式。
                        noLink: true
                }
            );

            // 第一个按钮“是”的索引为 0。
            return result === 0;
        } catch (error) {
            console.warn(
                "[思源安全关闭] 原生确认框不可用，" +
                "回退到 window.confirm：",
                error
            );

            return window.confirm(message);
        }
    }

    /**
     * 完整退出思源：
     *
     * 1. 请求内核退出；
     * 2. 通知 Electron 主进程退出对应端口的窗口。
     */
    async function quitSiYuan() {
        try {
            await requestApi("/api/system/exit");
        } catch (error) {
            /*
             * 内核退出时可能先关闭 HTTP 服务，
             * 从而导致 fetch 无法正常取得响应。
             * 此时仍继续通知 Electron 关闭窗口。
             */
            console.warn(
                "[思源安全关闭] 内核退出请求未正常返回，" +
                "继续关闭桌面窗口：",
                error
            );
        }

        try {
            const { ipcRenderer } = require("electron");

            ipcRenderer.send(
                "siyuan-quit",
                window.location.port
            );
        } catch (error) {
            console.error(
                "[思源安全关闭] 无法通知 Electron 退出：",
                error
            );

            if (
                (window.webkit &&
                window.webkit.messageHandlers) ||
                window.JSAndroid ||
                window.JSHarmony
            ) {
                window.location.href =
                "siyuan://api/system/exit";
            }
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
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            throw new Error(
                `${response.status} ${response.statusText}`
            );
        }

        return response.json();
    }

    function isLinux() {
        return (
            window.siyuan?.config?.system?.os === "linux" ||
            document.body.classList.contains("body--linux") ||
            /Linux/i.test(navigator.userAgent)
        );
    }

    function isMac() {
        return (
            window.siyuan?.config?.system?.os === "darwin" ||
            document.body.classList.contains("body--darwin") ||
            /Mac/i.test(navigator.platform)
        );
    }

    function isWindows() {
        return (
            window.siyuan?.config?.system?.os === "win32" ||
            document.body.classList.contains("body--win32")
        );
    }

    function isElectron() {
        return navigator.userAgent.includes("Electron");
    }
})();
