import type { ComponentProps } from 'react'
import MDEditor from '@uiw/react-md-editor'

export const safeMarkdownPlugins: NonNullable<ComponentProps<typeof MDEditor.Markdown>['pluginsFilter']> = (type, plugins) =>
  type === 'rehype' ? plugins.filter((plugin) => typeof plugin !== 'function' || plugin.name !== 'rehypeRaw') : plugins
