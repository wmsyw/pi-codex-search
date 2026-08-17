# pi-codex-search

`pi-codex-search` 为 Pi 与 OMP 提供同一个 `codex_search` 工具：使用当前激活的 OpenAI Responses 模型，通过其 provider 的 Codex Search 接口查询公开网页，并返回综合答案与来源。

> 本扩展不会自行选择 provider，也不会把密钥写入配置。调用前，请在宿主中选好要使用的 `openai-responses` 模型；已知的已配置凭据会在 HTTP 错误消息中脱敏，宿主侧错误则使用通用描述。

## 前置条件

- 已安装 **Pi** 或 **OMP**。
- 已配置一个当前激活的 `openai-responses` 模型。
- 该模型的 `baseUrl` 对应服务必须支持 `POST /v1/alpha/search`。例如，若 `baseUrl` 为 `https://example.invalid/v1`，扩展会请求 `https://example.invalid/v1/alpha/search`；末尾的 `/responses` 也会被规范化移除。
- Bun `>=1.3.14`（从源码开发或运行项目检查命令时需要）。

扩展只复用**当前激活模型**的 `provider`、`model`、`baseUrl` 与宿主解析出的凭据；它不是任意 provider 的通用搜索代理。

## 安装

本项目没有在文档中假定某个已发布版本或固定仓库 URL。以下命令使用占位符，执行时请替换为你实际可用的 npm 包名、Git source 或 checkout 路径；安装后重启宿主或按宿主方式重新加载 extensions。

`package.json` 中的 extension manifest 同时声明了 `pi.extensions` 和 `omp.extensions`，因此同一份包可由 Pi 与 OMP 加载。

### Pi

Pi 的持久化 extension 目录为 `~/.pi/agent/extensions/`。从 npm 包解压到该目录：

```sh
mkdir -p ~/.pi/agent/extensions/pi-codex-search
npm pack <npm-package-name>
tar -xzf <npm-package-tarball>.tgz --strip-components=1 \
  -C ~/.pi/agent/extensions/pi-codex-search
cd ~/.pi/agent/extensions/pi-codex-search
bun install --production
```

从 Git checkout 安装到同一持久化目录：

```sh
git clone <repository-url> ~/.pi/agent/extensions/pi-codex-search
cd ~/.pi/agent/extensions/pi-codex-search
bun install --production
```

本地源码开发可使用 symlink；本地源码目录必须先安装开发依赖：

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD" ~/.pi/agent/extensions/pi-codex-search
bun install
pi -e ./src/index.ts
```

### OMP

使用 OMP 已确认的 plugin CLI 路由安装 npm 包或 Git source：

```sh
omp plugin install <npm-package-or-git-source>
```

从本地 checkout 开发时，在源码目录执行：

```sh
bun install
omp plugin link "$PWD"
```

这两种 OMP 命令会使用包中声明的 `omp.extensions` manifest；不需要手动复制到未确认的目录。

## 模型配置示例

以下是需要合并到现有配置中的**字段示例**，不是完整配置文件。请按宿主现有格式填写，并通过宿主支持的环境变量、密钥存储或认证流程提供凭据。

### Pi `models.json`

```json
{
  "providers": {
    "my-responses": {
      "baseUrl": "https://example.invalid/v1",
      "models": [
        {
          "id": "responses-search-model",
          "api": "openai-responses",
          "name": "Responses Search Model"
        }
      ]
    }
  }
}
```

在 Pi 中将 `responses-search-model` 设为当前模型；实际凭据由 Pi 的 provider auth 配置解析，不要把真实 token 放进示例或提交到仓库。

### OMP `models.yml`

```yaml
providers:
  my-responses:
    baseUrl: https://example.invalid/v1
    models:
      - id: responses-search-model
        api: openai-responses
        name: Responses Search Model
```

在 OMP 中选择该模型为 active model，并按 OMP 的认证配置提供凭据。若你的 OMP 版本使用不同的模型列表外形，请保留等价的 `provider`、`id`、`api` 和 `baseUrl` 字段。

## 凭据与地址解析

扩展先读取 active model 的 `api`、`id`、`provider` 与 `baseUrl`，然后向该 provider 的 model registry 请求运行时认证信息：

1. 优先使用 `getProviderAuth(provider)`；
2. 否则使用 `getApiKeyAndHeaders(model)`；若该接口没有解析出 key，再回退到 `getApiKey(model, ...)`。

解析出的 auth `baseUrl`（若有）覆盖模型配置中的 `baseUrl`。请求 headers 先使用 active model headers，再合并解析出的 provider headers；同名解析结果优先。只有在最终 headers 尚无 `authorization` 时，才会把解析出的 API key 作为 `Authorization: Bearer ...` 添加。因此，provider 显式提供的 authorization header 优先于自动生成的 Bearer header。

## `codex_search` 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `query` | `string`，必填 | 网页搜索问题，不能为空。 |
| `domains` | `string[]`，可选 | 限制域名，最多 20 个非空字符串。 |
| `recencyDays` | `integer`，可选 | 只搜索最近指定天数；必须至少为 1。 |
| `responseLength` | `"short" \| "medium" \| "long"`，可选 | 期望的答案长度，默认 `medium`。 |

示例：

```json
{
  "query": "2026 年 TypeScript 发布说明",
  "domains": ["typescriptlang.org"],
  "recencyDays": 30,
  "responseLength": "short"
}
```

## 请求与响应行为

扩展向规范化后的 `<baseUrl>/alpha/search` 发送 JSON `POST` 请求。请求体包含：

- 随机 `id`；
- 当前激活模型的 `model`；
- `input: query`；
- `commands.search_query`，其中 `q` 来自 `query`，`recency` 来自 `recencyDays`，`domains` 来自 `domains`；
- `commands.response_length`（未提供时为 `medium`）；
- `settings.allowed_callers: ["direct"]` 与 `settings.external_web_access: true`；
- `max_output_tokens: 8000`。

成功响应必须是 JSON 对象且包含字符串 `output`。可选的字符串 `encrypted_output` 与数组 `results` 会原样保留；工具正文显示 `output`，来源等附加数据放在工具 details 中。响应体流式读取最多允许 8 MiB（`8 * 1024 * 1024` 字节），超过上限会取消读取并失败。HTTP 错误消息保留状态码/状态文本，并附带经脱敏且最多 1000 个字符的服务端消息；扩展会对已知的已配置 API key 和敏感 header 值进行脱敏，也不会暴露原始 `cause`。无效 JSON、缺少或错误类型的响应字段都会失败；取消信号和响应体读取错误会原样传播。

## 限制

- active model 的 API 必须严格为 `openai-responses`。
- `openai-codex-responses`、其他 API 类型或不支持 `/v1/alpha/search` 的服务会被拒绝。
- 不能在 `codex_search` 调用中指定任意 provider、model、endpoint 或凭据；必须先在 Pi/OMP 中切换 active model。
- 搜索服务、网络、宿主认证 resolver 或 provider headers 出错时，工具调用会返回错误，不会静默改用另一个 provider。

## 开发

```sh
bun install
bun run check
bun test
```

源码入口为 `src/index.ts`；`package.json` 中的 `check` 使用 `tsc --noEmit`，`test` 使用 `bun test`。

## 安全提示

不要将 API key、`Authorization` header、私有 endpoint 或真实认证响应提交到 Git、README、日志或 issue。使用 Pi/OMP 的官方密钥存储、环境变量或 provider auth 机制；共享配置示例时只使用占位域名和模型名。对于已知的已配置凭据，扩展会在 HTTP 错误消息中进行脱敏；宿主 credential resolver 的公开错误使用 provider 上下文和通用操作失败描述，不包含任意上游文本、对象或 cause。扩展会把搜索请求发送到当前 provider 的服务端，请确认该服务的隐私、数据保留和外部网页访问政策符合你的要求。
