import React from 'react';
import {paragraphDiff} from '../../shared/block-edit.mjs';
export default function ParagraphComparison({before,after}) {
  const change=paragraphDiff(before,after);
  return <section className="paragraph-comparison" aria-label="수정 전후 비교">
    <p className="comparison-key">삭제는 취소선, 추가는 밑줄로 표시합니다. 가운데 변경 구간을 하나로 묶어 보여줍니다.</p>
    <div className="comparison-grid">
      <div><h3>원문</h3><p className="comparison-before">{change.prefix}<del>{change.removed}</del>{change.suffix}{!before&&<em>빈 문단</em>}</p></div>
      <div><h3>수정안</h3><p className="comparison-after">{change.prefix}<ins>{change.added}</ins>{change.suffix}{!after&&<em>빈 문단</em>}</p></div>
    </div>
  </section>;
}
