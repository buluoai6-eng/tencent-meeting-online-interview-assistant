# Third-party notices

This source repository contains the original integration, interface, interview workflow, finance/accounting knowledge retrieval, prompt organization, correction rules, and test code for 腾讯会议线上面试助手 (Tencent Meeting Online Interview Assistant). It does not vendor the following projects' source code or model weights. The optional portable release bundles the Electron runtime and its license; the setup script downloads or installs the remaining third-party programs and models separately.

| Component | Purpose | Upstream license/source |
| --- | --- | --- |
| Electron | Desktop application runtime included in the optional portable build | MIT — <https://github.com/electron/electron> |
| sherpa-onnx | Offline speech recognition runtime | Apache-2.0 — <https://github.com/k2-fsa/sherpa-onnx> |
| SenseVoice | Speech recognition model | MIT repository license — <https://github.com/FunAudioLLM/SenseVoice> |
| Silero VAD | Voice activity detection model | MIT — <https://github.com/snakers4/silero-vad> |
| Ollama | Local model runtime | MIT — <https://github.com/ollama/ollama> |
| Qwen model | Local answer generation | Model files are not included. Review the license/model card for the exact model selected through <https://ollama.com/library/qwen3.5> and the official Qwen organization at <https://github.com/QwenLM>. |

The finance/accounting knowledge pack summarizes general concepts and links to authoritative sources for further reading. It does not reproduce accounting standards or regulatory publications in full. IFRS, US GAAP, COSO, Basel, Tencent Meeting, and all other names and trademarks belong to their respective owners.

This notice is informational and does not replace any upstream license or model card. Users are responsible for reviewing the current terms before downloading, using, modifying, or redistributing third-party components.
