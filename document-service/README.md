# MKnowledge Document Service

基于 **FastAPI（Uvicorn）** 的文档解析服务：支持 docx / xlsx / pdf / txt / md 等；可选通过 **Paddle PP-StructureV3** 做 PDF 版面解析（`PDF_LAYOUT_ENABLED=1`）。

## 文档

| 文档 | 说明 |
|------|------|
| **[../BUILD.md](../BUILD.md)** | **全仓库构建**（Docker Compose 默认路径、后端/前端、可选 profile） |
| **[DEPLOY.md](./DEPLOY.md)** | **Ubuntu 可复制部署**（APT、venv、Paddle、Docker、systemd、验收清单） |
| `requirements.txt` | Python 依赖；Paddle 为可选，见文件内注释 |

## 架构摘要

- 后端通过 `KB_DOCUMENT_SERVICE_URL` 调用本服务；若配置 **CPU + GPU 双池**，PDF 的 `/internal/v1/parse` 可走 GPU 实例（见 `backend/src/services/kbDocumentService.js`）。
- 根目录 `Dockerfile` **默认不含** Paddle；容器内跑版面需自建镜像或按 **DEPLOY.md** 使用本机 venv。

## 快速开始（开发）

```bash
cd document-service
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8002
```

生产与 Paddle 安装请严格按 **[DEPLOY.md](./DEPLOY.md)** 执行。

## 参考链接

- [PaddlePaddle Linux pip 安装](https://www.paddlepaddle.org.cn/documentation/docs/en/develop/install/pip/linux-pip_en.html)
- [PP-StructureV3 管线（PaddleOCR）](https://www.paddleocr.ai/latest/version3.x/pipeline_usage/PP-StructureV3.html)
