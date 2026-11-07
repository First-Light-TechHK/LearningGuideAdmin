import type { TagProps as AntTagProps } from 'antd'

/**
 * UI Tag 封装：透传 Ant Design props。
 * 预设语义色映射集中于此，未来 Figma 调整配色只需改本文件。
 */
export interface TagProps extends AntTagProps {}

/** 预设标签配色（与设计稿一致，集中管理；使用 antd 预设色名以保持视觉不变）
 *  未来 Figma 迁移时可改为 hex token 值。 */
export const TAG_PRESET_COLORS: Record<string, string> = {
  'Core Knowledge': 'blue',
  'Teaching Guidance': 'green',
  Misconception: 'orange',
  Assessment: 'purple',
}
