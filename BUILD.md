# Docker 安装与运行（简版）

本文只记录 **用仓库根目录的 `docker-compose.yml` 起服务** 的方式。更细的 venv / 本机 Paddle 部署见 [document-service/DEPLOY.md](./document-service/DEPLOY.md)。

---

## 1. 宿主机要准备什么

| 用途 | 是否需要 | 说明 |
|------|----------|------|
| Docker Engine + Compose v2 | **需要** | [Docker 安装文档](https://docs.docker.com/engine/install/) |
| **仅跑文档服务容器** 时在宿主机装 Python / 飞桨 | **不需要** | 解析在容器里完成；**飞桨（GPU 版）在镜像构建时由 `Dockerfile.gpu` 内 `pip install` 装好**，不必在宿主机预先安装 Paddle。 |
| 跑本仓库 **Node 后端** | **需要** | 本机安装 **Node.js 20+**（与 `backend/package.json` 一致）；与 Docker 文档服务是两回事。 |
| 使用 **`document-service-gpu`** | **需要** | 安装 **NVIDIA 驱动**（`nvidia-smi` 正常）+ [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)；验证示例：`docker run --rm --gpus all nvidia/cuda:12.0.0-base-ubuntu22.04 nvidia-smi` |

---

## 2. 根目录 `.env` 与 Compose

- **Compose 文件**：仓库根目录的 **`docker-compose.yml`**；启动命令一律在**仓库根目录**执行。
- **变量文件**：根目录 **`.env`**（可由 [`.env.example`](./.env.example) 复制）。Compose 会自动读取根目录 `.env` 做插值（端口、`KB_DOCUMENT_SERVICE_API_KEY`、`PADDLE_WHEEL_INDEX` 等）。

**GPU 镜像构建**：`document-service-gpu` 构建时会读 **`PADDLE_WHEEL_INDEX`**（默认 `cu126`），用于从飞桨源安装与 CUDA 线匹配的 `paddlepaddle-gpu` wheel。请按本机驱动支持的 CUDA 用户态，对照 [飞桨 Linux pip 安装说明](https://www.paddlepaddle.org.cn/documentation/docs/zh/install/pip/linux-pip.html) 选择 `cu118` / `cu126` / `cu129` / `cu130` 等；选错常见现象是构建失败或容器内无法使用 GPU。

根目录 `.env` 中与文档服务相关的示例项（以 `.env.example` 为准）：

- `PADDLE_WHEEL_INDEX` — 仅影响 **GPU 镜像构建**。
- `DEBIAN_APT_MIRROR_HOST` — 可选。构建 `document-service-gpu` 时若 **`apt-get update` 长时间停在 `deb.debian.org`**（国内网络常见），在根目录 `.env` 中设置 **`DEBIAN_APT_MIRROR_HOST=mirrors.aliyun.com`** 后再 `build`；海外机器一般留空即可。
- `PIP_INDEX_URL` — 可选。若 pip 报 **`No matching distribution found for pypdf` 且 `(from versions: none)`**，说明 **未从当前索引拿到任何包版本**（多为访问 **pypi.org** 失败）。Compose 对 GPU 镜像构建默认使用 **清华 PyPI 镜像**；在海外若镜像反而慢，可在 `.env` 中设 **`PIP_INDEX_URL=https://pypi.org/simple`**。
- `KB_DOCUMENT_SERVICE_API_KEY` — 若启用，须与 **`backend/.env` 里同名变量一致**。
- `DOCUMENT_SERVICE_PORT` / `DOCUMENT_SERVICE_GPU_PORT` — 宿主机映射端口（默认 CPU **8002**，GPU **8003** → 容器内均为 **8002**）。

---

## 3. 启动步骤（Docker）

**仅 CPU 文档服务**（默认随全量 `up` 或单独起服务均可）：

```bash
cd /path/to/ragKnowledge
cp .env.example .env   # 首次：编辑 .env 中的密钥等
docker compose up -d
```

**另起 GPU 文档服务**（需本机 GPU + Toolkit；首次会 **build**，时间较长）：

```bash
# 已在根目录 .env 中设置好 PADDLE_WHEEL_INDEX（apt 慢时再加 DEBIAN_APT_MIRROR_HOST）
docker compose --profile gpu build --progress=plain document-service-gpu
docker compose --profile gpu up -d document-service document-service-gpu
```

若曾卡在 apt 层，改过 `.env` 后建议 **`docker compose --profile gpu build --no-cache --progress=plain document-service-gpu`**，避免误用旧缓存层。

---

## 4. 与 `backend/.env` 对齐（必查）

后端连文档服务只看 **`backend/.env`**（可由 `backend/env.template` 复制）。须与当前运行方式一致，例如 **后端在宿主机、文档服务由 Compose 映射端口** 时：

```env
KB_DOCUMENT_SERVICE_URL=http://127.0.0.1:8002
KB_DOCUMENT_SERVICE_GPU_URL=http://127.0.0.1:8003
KB_DOCUMENT_SERVICE_API_KEY=与根目录 .env 中 KB_DOCUMENT_SERVICE_API_KEY 相同
```

若后端也跑在 **同一 Compose 网络内的容器**里，应使用服务名与**容器端口 8002**（不是宿主机 8003），例如：

`http://document-service:8002`、`http://document-service-gpu:8002`。

更多变量说明见 **`backend/env.template`** 注释。

---

## 5. 飞桨到底要预先装什么？

| 场景 | 结论 |
|------|------|
| **只用 Docker 起 `document-service` / `document-service-gpu`** | **宿主机不必安装飞桨**；CPU 镜像按 `document-service/Dockerfile` 安装依赖，GPU 镜像按 **`document-service/Dockerfile.gpu`** 在构建阶段安装 `paddlepaddle-gpu`、`paddlex[ocr]`、`paddleocr` 等。 |
| **本机 Python 直接跑 document-service** | 才需要在宿主机按 `document-service/DEPLOY.md` 自行安装 Paddle 等。 |

---

## 6. 可选延伸阅读

- [document-service/DEPLOY.md](./document-service/DEPLOY.md) — 本机 venv / systemd，非 Docker 主路径  
- [backend/env.template](./backend/env.template) — 后端环境变量模板  
