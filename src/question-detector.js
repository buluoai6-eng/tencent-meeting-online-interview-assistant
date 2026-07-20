const DIRECT_QUESTION = /(?:请(?:你|您)?|介绍(?:一下|下)?|讲(?:一下|下|讲)?|谈(?:一下|下|谈)?|说(?:一下|下|说)?|聊(?:一下|下|聊)?|解释|阐述|说明|分析|比较|对比|区分|评价|判断|列举|举例|概述|总结|拆解|计算|回答|如何|为什么|什么|哪些|哪个|哪种|怎么|是否|有没有|能不能|可以.*吗|你觉得|你认为|假如|如果.*你)/i;
const IMPLIED_REQUEST = /(?:的(?:主要|核心|本质)?区别|有什么(?:区别|不同)|各?举.{0,8}(?:例子|案例)|意味着什么|原因(?:和|及|与)风险|影响有哪些|处理方法|会计处理|审计程序|核心步骤|如何理解)/i;
const ENGLISH_QUESTION = /(?:what|why|how|could you|can you|would you|tell me|describe|explain|compare|walk me through)/i;

function likelyQuestion(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length < 4) return false;
  if (/[?？]\s*$/.test(normalized)) return true;
  return DIRECT_QUESTION.test(normalized) || IMPLIED_REQUEST.test(normalized) || ENGLISH_QUESTION.test(normalized);
}

module.exports = { likelyQuestion };
