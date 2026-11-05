/**
 * UI 组件统一出口（2026-10-16 新增，为 Figma 设计库迁移铺路）
 *
 * 业务组件必须从此处导入 UI 组件，禁止直接 import from 'antd'。
 * 未来接入 Figma 设计库（code-connect / 独立组件库 / 仅 token）时，
 * 只需修改本目录下的封装实现，业务组件无需改动。
 */

// ===== 封装组件 =====
export { Button } from './Button'
export type { ButtonProps } from './Button'

export { Card } from './Card'
export type { CardProps } from './Card'

export { Panel } from './Panel'
export type { PanelProps } from './Panel'

export { Input, TextArea } from './Input'
export type { InputProps } from './Input'

export { Select } from './Select'
export type { SelectProps } from './Select'

export { Tag } from './Tag';
export { TAG_PRESET_COLORS } from './tagColors';
export type { TagProps } from './tagColors';

export { default as Modal } from './Modal'
export type { ModalProps } from './Modal'

export { Table } from './Table'
export type { TableProps } from './Table'

export { Tree } from './Tree'
export type { TreeProps, TreeDataNode } from './Tree'

export { Tabs } from './Tabs'
export type { TabsProps } from './Tabs'

export { Segmented } from './Segmented'
export type { SegmentedProps } from './Segmented'

export { Avatar } from './Avatar'
export type { AvatarProps } from './Avatar'

export { Typography, Text, Title, Paragraph } from './Typography'
export type { TypographyProps } from './Typography'

export { Layout, Sider, Header, Content, Footer } from './Layout'
export type { LayoutProps, SiderProps } from './Layout'

// ===== 透传组件（暂不需要 token 默认值覆盖，直接从 antd 导出） =====
export { Alert, Spin, Tooltip, Dropdown, Popconfirm, Popover, Empty, Space, Upload, App, AutoComplete, Switch, Divider } from 'antd'

// ===== 类型透传 =====
export type { MenuProps, UploadProps, UploadFile } from 'antd'
export type { ColumnsType } from 'antd/es/table'
