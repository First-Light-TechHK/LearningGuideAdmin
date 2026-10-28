import { Tag, AutoComplete, Button, Space, Popover } from '../ui'
import { CloseOutlined, PlusOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { useWorkspaceAccess } from '../../backoffice/lib/workspaceAccess'
import { useKText } from './i18n'

interface TagManagerProps {
  tags: string[]
  onChange: (tags: string[]) => void
  /** 紧凑模式（用于 section 下方） */
  compact?: boolean
}

/** 预设色板：name -> antd preset color（与后端 ALLOWED_TAG_COLORS 一致） */
const PRESET_COLORS = [
  { name: 'blue', hex: '#1D6BFF' },
  { name: 'green', hex: '#52c41a' },
  { name: 'orange', hex: '#fa8c16' },
  { name: 'purple', hex: '#722ed1' },
  { name: 'red', hex: '#ff4d4f' },
  { name: 'cyan', hex: '#13c2c2' },
  { name: 'gold', hex: '#faad14' },
  { name: 'magenta', hex: '#eb2f96' },
]

/** 颜色选择面板：8 个预设色点，点击选中 */
function ColorPalette({
  value,
  onChange,
}: {
  value: string
  onChange: (color: string) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 6, padding: 4 }}>
      {PRESET_COLORS.map((c) => (
        <div
          key={c.name}
          onClick={() => onChange(c.name)}
          style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: c.hex,
            cursor: 'pointer',
            border: value === c.name ? '2px solid #000' : '2px solid transparent',
            boxSizing: 'border-box',
            transition: 'transform 0.1s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.15)')}
          onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
          title={c.name}
        />
      ))}
    </div>
  )
}

/**
 * Tags 管理（§3.3.3 方案 B 轻量版）：
 * - 输入框带 AutoComplete 联想全局 Tag 词库；命中词库则用其配色
 * - 点击推荐项 → 填入输入框（不立即添加），按 Enter 或失焦才提交
 * - 推荐项左侧色点可点击改色，右侧 × 可从词库删除
 * - 推荐上限 5 个，超出可滚动
 * - 新增 tag 时可选择颜色（不传则后端按 name 哈希分配）
 * - 已添加的 tag 左侧色点可点击改色
 */
export function TagManager({ tags, onChange, compact }: TagManagerProps) {
  const { text } = useKText()
  const access = useWorkspaceAccess()
  const tagLibrary = useKnowledgeStore((s) => s.tags)
  const tagsLoading = useKnowledgeStore((s) => s.tagsLoading)
  const loadTags = useKnowledgeStore((s) => s.loadTags)
  const createTag = useKnowledgeStore((s) => s.createTag)
  const deleteTag = useKnowledgeStore((s) => s.deleteTag)
  const updateTagColor = useKnowledgeStore((s) => s.updateTagColor)
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState('')
  /** 新增 tag 时用户选择的颜色（空字符串表示用后端默认分配） */
  const [newTagColor, setNewTagColor] = useState('')
  const deletingRef = useRef(false)

  useEffect(() => {
    if (tagLibrary.length === 0 && !tagsLoading) void loadTags()
  }, [tagLibrary.length, tagsLoading, loadTags])

  const colorMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of tagLibrary) m.set(t.name, t.color)
    return m
  }, [tagLibrary])

  const options = useMemo(
    () =>
      tagLibrary
        .filter((t) => !tags.includes(t.name))
        .map((t) => ({ value: t.name, color: t.color })),
    [tagLibrary, tags],
  )

  const commit = async () => {
    const t = value.trim()
    if (!t) {
      setValue('')
      setNewTagColor('')
      setAdding(false)
      return
    }
    if (tags.includes(t)) {
      setValue('')
      setNewTagColor('')
      setAdding(false)
      return
    }
    if (!colorMap.has(t)) {
      try {
        await createTag(t, newTagColor || undefined)
      } catch {
        // 创建失败仍允许本地加（颜色 fallback）
      }
    }
    onChange([...tags, t])
    setValue('')
    setNewTagColor('')
    setAdding(false)
  }

  const handleDelete = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    deletingRef.current = true
    try {
      await deleteTag(name)
    } catch {
      // 删除失败不打扰
    } finally {
      setTimeout(() => {
        deletingRef.current = false
      }, 0)
    }
  }

  /** 修改词库中已有 tag 的颜色 */
  const handleChangeColor = async (name: string, color: string) => {
    try {
      await updateTagColor(name, color)
    } catch {
      // 失败不打扰
    }
  }

  const tagColor = (name: string) => colorMap.get(name) ?? 'default'

  /** 根据 color name 取 hex（用于色点显示） */
  const colorHex = (name: string) => {
    const c = PRESET_COLORS.find((p) => p.name === name)
    return c?.hex ?? '#bfbfbf' // default 灰
  }

  return (
    <Space size={[4, 4]} wrap>
      {tags.map((tag) => (
        <Popover
          key={tag}
          content={
            <ColorPalette
              value={tagColor(tag)}
              onChange={(c) => void handleChangeColor(tag, c)}
            />
          }
          trigger="click"
          placement="top"
        >
          <Tag
            color={tagColor(tag)}
            closable
            onClose={() => onChange(tags.filter((t) => t !== tag))}
            style={compact ? { margin: 0, cursor: 'pointer' } : { cursor: 'pointer' }}
          >
            {tag}
          </Tag>
        </Popover>
      ))}
      {adding ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <AutoComplete
              size="small"
              autoFocus
              style={{ width: 140 }}
              value={value}
              options={options}
              listHeight={160}
              filterOption={(input, option) =>
                (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
              optionRender={(option) => {
                const opt = option as unknown as { value: string; color: string }
                return (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {/* 色点：点击改色 */}
                    <Popover
                      content={
                        <ColorPalette
                          value={opt.color ?? 'default'}
                          onChange={(c) => void handleChangeColor(opt.value, c)}
                        />
                      }
                      trigger="click"
                      placement="left"
                    >
                      <span
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: '50%',
                          background: colorHex(opt.color ?? 'default'),
                          display: 'inline-block',
                          flexShrink: 0,
                          cursor: 'pointer',
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Popover>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {opt.value}
                    </span>
                  </div>
                  {access.canDelete && (
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined style={{ fontSize: 10 }} />}
                      style={{ padding: 0, width: 16, height: 16, minWidth: 0, flexShrink: 0 }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => void handleDelete(opt.value, e)}
                    />
                  )}
                </div>
                )
              }}
              onChange={setValue}
              onBlur={() => {
                if (deletingRef.current) return
                void commit()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commit()
                if (e.key === 'Escape') {
                  setValue('')
                  setNewTagColor('')
                  setAdding(false)
                }
              }}
              onSelect={(val) => setValue(val)}
            />
            {/* 新增 tag 的颜色选择：当前选中色点 */}
            <Popover
              content={
                <ColorPalette value={newTagColor || 'default'} onChange={setNewTagColor} />
              }
              trigger="click"
              placement="top"
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: newTagColor ? colorHex(newTagColor) : '#d9d9d9',
                  display: 'inline-block',
                  cursor: 'pointer',
                  border: '1px solid #d9d9d9',
                }}
                title={text('tag.chooseColor')}
              />
            </Popover>
          </div>
        </div>
      ) : (
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          onClick={() => setAdding(true)}
        >
          {text('tag.add')}
        </Button>
      )}
    </Space>
  )
}
