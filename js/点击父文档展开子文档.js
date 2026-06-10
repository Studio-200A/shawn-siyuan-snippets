/* 文档树点击文档自动展开下级 JS片段 */
setTimeout(() => {
    console.log("加载代码片段：自动展开文件树");
    document.querySelector('.sy__file').addEventListener('mousedown', event => {
        if (!event.target.classList.contains('b3-list-item__text')) return;
        if (event.target.parentNode.getAttribute("data-type") !== "navigation-file") return;
        const b3ListItemToggle = event.target.parentNode.querySelector('.b3-list-item__toggle');
        if (b3ListItemToggle.classList.contains('fn__hidden')) return;
        b3ListItemToggle.click();
    });
}, 200);
