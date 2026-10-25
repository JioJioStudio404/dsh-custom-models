# dsh-custom-models

DeepSeek Harness 的自定义 API 插件，用于接入你自己的 API 站点：中转站（new-api / one-api）、聚合网关、自建服务、本机 Ollama / LM Studio。

## 功能

- 每个站点可放多个 Key，显示状态、余额、今日用量与花费
- Key 和站点都由你手动切换，不会自动切换
- 获取站点的可用模型，并自动补全上下文、推理档位等信息
- 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议，请求方式与 DSH 自带的自定义网关一致
- 切换组：模型选择栏里的一个条目，由你选定的站点提供
- 推理强度、工具调用、思考内容回传

## 安装

```bash
git clone https://github.com/JioJioStudio404/dsh-custom-models.git
dsh plugin --profile desktop add "/path/to/dsh-custom-models"
```

安装后重启 DeepSeek Harness。

## 许可证

MIT。打包的第三方代码的许可证见 `lib/vendor/LICENSES.txt`。
