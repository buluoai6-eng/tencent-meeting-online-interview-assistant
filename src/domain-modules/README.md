# 领域模块编写指南

领域模块让“线上会议面试助手”在不修改程序源码的情况下加载一组专用术语纠错和领域知识。模块只使用本地 JSON 文件，不执行 JavaScript、Python 或其他代码。

## 快速开始

1. 在应用中打开“设置 → 领域”。
2. 点击“打开模块目录”。首次打开时，应用会在目录中放入本说明和 `_template` 模板。
3. 复制 `_template` 文件夹，并把副本改成容易识别的英文目录名，例如 `software-engineering`。
4. 修改副本中的 `module.json`、`corrections.json` 和 `knowledge.json`。
5. 回到应用点击“重新扫描”，然后从下拉列表选择新模块。
6. 模块选择在下次开始监听时生效，不需要重新安装模型。

一个完整模块的目录结构如下：

```text
software-engineering/
├─ module.json
├─ corrections.json
└─ knowledge.json
```

只有 `module.json` 必需。如果不需要术语纠错或知识库，可以省略对应文件和字段。

## module.json

```json
{
  "schema_version": 1,
  "id": "software-engineering",
  "name": "软件工程",
  "version": "1.0",
  "description": "面向后端、架构和工程效率面试的领域增强。",
  "corrections_file": "corrections.json",
  "knowledge_file": "knowledge.json",
  "answer_instructions": [
    "技术方案要说明适用条件、权衡和失败模式。",
    "不要虚构性能数据、线上事故或候选人的项目经历。"
  ]
}
```

字段说明：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `schema_version` | 是 | 当前固定为数字 `1` |
| `id` | 是 | 模块唯一标识，使用小写英文字母、数字、点、下划线或连字符，长度 2–64 |
| `name` | 是 | 应用内显示名称，最长 80 个字符 |
| `version` | 是 | 模块自己的版本，不影响应用版本 |
| `description` | 否 | 模块用途，最长 300 个字符 |
| `corrections_file` | 否 | 术语纠错 JSON，必须位于当前模块目录内 |
| `knowledge_file` | 否 | 领域知识 JSON，必须位于当前模块目录内 |
| `answer_instructions` | 否 | 最多 12 条领域回答约束，每条最长 500 个字符 |

用户模块的 `id` 不能与内置模块或其他用户模块重复。文件引用不能使用 `..` 跳出模块目录。

## corrections.json

```json
{
  "description": "软件工程常见语音误识别修正",
  "replacements": [
    {
      "canonical": "Kubernetes",
      "aliases": ["库伯内特斯", "K8 S", "K 8 S"]
    },
    {
      "canonical": "幂等性",
      "aliases": ["密等性", "幂等型"]
    }
  ]
}
```

- `canonical` 是最终显示的标准术语，最长 80 个字符。
- `aliases` 是常见误识别结果，每条规则最多 20 个。
- 一个模块最多 500 条纠错规则。
- 替换发生在本地语音识别之后，同时作用于灰色临时字幕和最终转写。
- 不要加入“有、是、做”等过短且含义宽泛的别名，否则可能误改正常句子。
- 纠错是字面替换，不理解上下文；存在歧义的词应交给知识库和回答模型处理。

## knowledge.json

```json
{
  "version": "1.0",
  "context_note": "未说明技术栈时先确认语言、规模、延迟目标和一致性要求，不虚构线上指标。",
  "fallback_section_ids": ["engineering-framework"],
  "always_include_section_ids": ["engineering-framework"],
  "sections": [
    {
      "id": "distributed-systems",
      "title": "分布式系统基础",
      "keywords": ["分布式", "一致性", "可用性", "CAP", "复制", "分区"],
      "content": "回答分布式系统题时先明确故障模型和业务目标，再讨论一致性、可用性、延迟与成本的权衡。"
    },
    {
      "id": "engineering-framework",
      "title": "软件工程面试回答框架",
      "keywords": ["设计", "架构", "优化", "排查", "如何"],
      "content": "先给目标和约束，再给方案、关键组件、取舍、风险、验证指标和回滚策略。"
    }
  ],
  "sources": [
    "https://example.com/your-authoritative-source"
  ]
}
```

字段说明：

- `context_note`：每次召回都会加入的领域口径或安全提醒，最长 3000 个字符。
- `sections`：最多 100 个知识条目。
- `id`：条目唯一标识，规则与模块 `id` 相同。
- `title`：条目标题，最长 100 个字符。
- `keywords`：每个条目 1–50 个关键词，每个最长 80 个字符；可以同时放中文、英文和缩写。
- `content`：用于回答的知识摘要，最长 8000 个字符。
- `fallback_section_ids`：问题没有命中任何关键词时使用的条目，最多 20 个。
- `always_include_section_ids`：只要仍有召回名额就附加的回答框架，最多 20 个。
- `sources`：可选来源链接，仅用于维护和审核，不会在面试时联网读取。

应用按关键词和标题匹配知识，最多召回 3 个条目、总长度最多约 4200 个字符。关键词越具体越好，例如使用“预期信用损失”而不是单独使用“损失”。

## 编写建议

- 写“稳定原理、分析框架和常见错误”，不要复制大段教材、标准或受版权保护的文章。
- 把容易变化的法律、税率、监管阈值和产品版本写成核对提醒，不要写成永久事实。
- 内容应帮助用户组织真实回答，不要在模块中编造个人项目、业绩或从业经历。
- 优先引用权威来源，并在 `sources` 中记录维护依据。
- 修改后先检查 JSON：不能包含注释、尾随逗号或中文引号。
- 如果模块无效，应用会在“领域”页显示第一个错误；修复后点击“重新扫描”。

## 隐私与加载范围

- 模块文件保存在应用数据目录，不会随 Git 仓库上传。
- 本地回答模式下，模块知识只发送给本机 Qwen。
- 使用自己的 API 时，召回的模块知识会与问题、最近对话和面试准备信息一起发送到用户配置的 API 服务商。
- 应用只读取模块目录内声明的 JSON 文件，不执行模块中的代码，也不允许文件引用跳出模块目录。
