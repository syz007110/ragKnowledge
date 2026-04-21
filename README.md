# ragKnowledge / MKnowledge

知识库与检索相关能力的单体/多服务仓库：包含 **Node 后端**、**Vue 前端**、**Python 文档解析服务**（`document-service`）及 **Docker Compose** 编排的中间件（PostgreSQL、Redis、Elasticsearch、Qdrant、MinIO、OnlyOffice 等）。

## 快速开始（推荐给首次拉取者）

1. **克隆**

   ```bash
   git clone <本仓库 URL> ragKnowledge
   cd ragKnowledge
   ```

2. **根目录环境变量（Compose 通过 `${变量}` 引用，勿把密钥写进 `docker-compose.yml`）**

   ```bash
   cp .env.example .env
   # 编辑 .env：数据库 / MinIO / ES / OnlyOffice / 文档服务 等与 backend/.env 对齐；生产环境替换所有默认口令
   ```

   通用随机密钥可用：`openssl rand -base64 48`。若启用 **Kibana**，还需填写 `KIBANA_ENCRYPTION_KEY`（自生成）与 `KIBANA_ES_SERVICE_ACCOUNT_TOKEN`（向 Elasticsearch 申请），详见 **[BUILD.md](./BUILD.md)** 中的 **「2.1 Kibana 相关变量填写说明」**。

3. **启动依赖（示例：数据库 + Redis + MinIO + 文档服务）**

   ```bash
   docker compose build document-service
   docker compose up -d postgres redis minio minio-init document-service
   ```

4. **配置并启动后端**

   ```bash
   cd backend && cp env.template .env
   # 按 backend/env.template 说明填写；与 Compose 中服务账号、端口一致
   npm install && npm run dev
   ```

更完整的场景说明、全量栈、GPU 文档池与排错见 **[BUILD.md](./BUILD.md)**。

## 文档索引

| 文档 | 内容 |
|------|------|
| [BUILD.md](./BUILD.md) | **构建与本地运行**（Docker Compose 默认路径、后端/前端、可选 profile） |
| [document-service/DEPLOY.md](./document-service/DEPLOY.md) | 文档服务 **Ubuntu 本机 venv + Paddle** 可复制部署 |
| [document-service/README.md](./document-service/README.md) | 文档服务说明与 venv/Docker 差异 |
| [backend/env.template](./backend/env.template) | 后端环境变量模板 |

## 参与贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全

漏洞报告与责任披露见 [SECURITY.md](./SECURITY.md)。

## 许可证

（在添加 `LICENSE` 文件后于此处注明 SPDX 标识，例如 MIT / Apache-2.0。）
