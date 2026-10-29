import { useAiStore } from "../../stores/aiStore";
import { useKnowledgeStore } from "../../stores/knowledgeStore";

/**
 * 退出登录后清掉上一位员工留在本机的工作数据：
 * AI Tutor 测试会话（localStorage `aitutor.chat.*`）以及内存里的 AI / Knowledge 状态，
 * 同一浏览器换人登录时不会看到前一个人的内容。
 */
export function clearEmployeeWorkspace(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith("aitutor.chat.")) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // 隐私模式等场景 localStorage 不可用：没有可清的数据
  }
  useAiStore.setState(useAiStore.getInitialState(), true);
  useKnowledgeStore.setState(useKnowledgeStore.getInitialState(), true);
}
