# dsh-custom-models

DeepSeek Harness 的自定义 API 插件，用于接入你自己的 API 站点：中转站（new-api / one-api / sub2api / claude-relay-service）、聚合网关、自建服务、本机 Ollama / LM Studio。

## 功能

- 每个站点可放多个 Key，显示状态、余额、今日用量与花费
- Key 和站点都由你手动切换，不会自动切换；服务端错误（如网关超时 524）、超时、连接中断时由 DeepSeek Harness 自动重试，最多 8 次、合计约 2 分钟
- 获取站点的可用模型，并自动补全上下文、推理档位等信息；站点未给出上下文时，从站点的报错中识别实际上限
- 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议，请求方式与 DeepSeek Harness 自带的自定义网关一致（pi-ai 1.3.0）
- 切换组：模型选择栏里的一个条目，由你选定的站点提供
- 用量统计：按站点、模型、日期记录请求数、Token、缓存命中、首字延迟与输出速度，并按你设置的价格估算花费
- 模型核验（默认关闭）：检测站点的服务异常，以及响应特征与标称模型是否一致，并单独评估服务表现；除经 Anthropic 官方 API 的签名校验外，结论不构成真实性认证（站点自报的数据可以任意填写），每条依据标注其依据类型
  - 被动监测：记录响应的元数据，不发送额外请求，不保存对话内容
  - 主动检测：身份核验、协议检测、签名校验、知识指纹；检测请求计入用量
- 上下文与图片：站点不报用量时交给 DeepSeek Harness 估算；请求体超限（413）时自动替换旧图片或压缩上下文；可按站点设置默认上下文和图片额度
- 推理强度、工具调用、思考内容回传
- 中转站适配（new-api / sub2api / claude-relay-service），全部只读：
  - 站点实际扣费：读取站点为该 Key 记录的日志或用量统计，与插件估算并列显示
  - 价格：new-api 按 Key 实际所在分组计算，支持按次计费与缓存写入价格；sub2api 读取模型广场价格并乘以该 Key 的计费倍率，高峰时段另计
  - 协议：按站点声明的接口类型为每个模型自动选择 Chat / Responses / Messages
  - 余额：new-api 可显示账户余额（令牌开启查询账户额度，或填写只读账户访问令牌）；sub2api 显示计费倍率与高峰时段；claude-relay-service 显示各项费用上限与限流窗口
  - 模型核验：new-api 站点日志中记录的模型映射、返回模型不符、系统提示词改写，作为核验证据
  - 仅允许官方客户端的 Key（如仅限 Claude Code 的分组）会被识别并标注，插件不会伪装成官方客户端

## 安装

### 通过插件索引安装（推荐）

1. 在 DeepSeek Harness 的**插件**页，于**实验性插件**中打开**自定义插件索引**。
2. 切换到**发现**，点击**添加索引源**，填入：

   ```
   https://raw.githubusercontent.com/JioJioStudio404/dsh-jiojiostudio404-index/main/index.json
   ```

3. 在列表中找到本插件并确认安装，安装后重启 DeepSeek Harness。之后发布的新版本会显示**有新版本**，可在应用内更新。

### 从源码安装

需要 Node.js 24.9 或更高版本（DeepSeek Harness 0.2.2 的最低要求）。

```bash
git clone https://github.com/JioJioStudio404/dsh-custom-models.git
dsh plugin --profile desktop add "/path/to/dsh-custom-models"
```

安装后重启 DeepSeek Harness。

## 致谢

知识指纹的方法、提示词、题型与题库来自 [KBF: Knowledge Boundary as Fingerprint](https://github.com/Ooo0ption/KBF)（Apache License 2.0）。插件内置了其提示词与题型模板、容差，以及题库的索引与校验值；题库本身在使用时从 KBF 仓库下载。检测流程按插件需要重新实现。

## 许可证

MIT。打包的第三方代码（pi-ai 等）的许可证见 `lib/vendor/LICENSES.txt`；KBF 的内容按 Apache License 2.0 使用，许可证全文同见该文件。
