import type { ReleaseSummary } from '../../api/knowledge'
import { tokens } from '../../theme/tokens'
import { Space, Tag, Tooltip } from '../ui'
import { useAiText } from './i18n'

export function AiReleaseOption({ release }: { release: ReleaseSummary }) {
  const { text } = useAiText()
  const notes = release.revisionNotes?.trim()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.xs, minWidth: 220, padding: `${tokens.spacing.xs}px 0` }}>
      <Space size="small">
        <span>{release.versionTag}</span>
        {release.isActive && <Tag color="green">{text('live')}</Tag>}
      </Space>
      <Tooltip title={notes || undefined}>
        <span style={{
          display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          fontSize: tokens.fontSize.md, lineHeight: 1.4,
          color: notes ? tokens.color.text.secondary : tokens.color.text.tertiary,
        }}>
          {notes || text('noRevisionNotes')}
        </span>
      </Tooltip>
    </div>
  )
}
