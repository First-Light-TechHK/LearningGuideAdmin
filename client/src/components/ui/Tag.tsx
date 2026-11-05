import { Tag as AntTag } from 'antd';
import type { TagProps } from './tagColors';



export function Tag(props: TagProps) {
  return <AntTag {...props} />
}


export default Tag