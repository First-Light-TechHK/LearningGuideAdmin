import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result } from 'antd'

/**
 * 全局错误边界（2026-10-27 新增）：
 * 捕获子树渲染阶段的未捕获异常，避免整个 React 树崩溃导致白屏。
 * 例如 Markdown 源码编辑器/预览渲染异常时抛出的错误会被此处兜底。
 * 展示错误信息 + 重载按钮，方便用户恢复。
 */
interface Props {
  children: ReactNode
}
interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台输出便于排查；不向用户暴露内部实现细节
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] 捕获到渲染异常:', error, info)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      const msg = this.state.error?.message || '未知错误'
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#f5f7fa',
          }}
        >
          <Result
            status="error"
            title="页面渲染异常"
            subTitle={`错误信息：${msg}`}
            extra={[
              <Button type="primary" key="reload" onClick={this.handleReload}>
                重新加载
              </Button>,
            ]}
          />
        </div>
      )
    }
    return this.props.children
  }
}
