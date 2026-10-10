import { Link } from 'react-router'

/** 页头"使用说明"链接：跳到使用手册对应章节 */
export default function PageHelpLink({ anchor = 'pages' }: { anchor?: string }) {
  return (
    <Link to={`/help#${anchor}`} className="text-[#007AFF] hover:underline">
      使用说明
    </Link>
  )
}
