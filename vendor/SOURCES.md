# vendor/ 来源清单

这些文件是 `node tools/vendor.mjs` 从 node_modules 拷过来的，**不要手改**。
改版本请改 package.json 后重跑 `npm install && npm run vendor`。

| 文件 | 来源 | 版本 | 体积 | 许可证 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `mux.min.js` | mux.js | 6.3.0 | 111.8 KB | Apache-2.0 | TS → fMP4 重封装（不需要 ffmpeg.wasm 的那条路） |
| `mp4-muxer.mjs` | mp4-muxer | 5.2.2 | 67.4 KB | MIT | WebCodecs 编码结果直接封装成 MP4（录制兜底用） |
| `webm-muxer.mjs` | webm-muxer | 5.1.4 | 63.4 KB | MIT | 把 WebM 画面轨（VP8/VP9/AV1）和 Opus 音轨封成一个 .webm（抓流里的 WebM 站点用） |

生成时间：2026-09-20T17:31:40.549Z
