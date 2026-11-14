import {BlockNoteSchema,createStyleSpec,defaultStyleSpecs} from '@blocknote/core';
import {fontSize} from './appearance.mjs';
const sizeStyle=createStyleSpec({type:'fontSize',propSchema:'string'},{
 render(value){const dom=document.createElement('span');dom.style.fontSize=fontSize(value)+'px';return {dom,contentDOM:dom};},
 parse(element){const px=element.style.fontSize;return /^\d+(\.\d+)?px$/.test(px)?String(fontSize(parseFloat(px))):undefined;}
});
export const editorSchema=BlockNoteSchema.create({styleSpecs:{...defaultStyleSpecs,fontSize:sizeStyle}});
export function applyFontSize(editor,px,wholeDocument) {
 px=String(fontSize(px));
 if(!wholeDocument){editor.addStyles({fontSize:px});return;}
 // One native transaction: existing IDs, links, marks and nested blocks survive.
 editor.transact(tr=>{const mark=tr.doc.type.schema.marks.fontSize.create({stringValue:px});
  tr.doc.descendants((node,pos)=>{if(node.isText)tr.addMark(pos,pos+node.nodeSize,mark);});
  tr.setStoredMarks([...(tr.storedMarks??tr.selection.$from.marks()).filter(m=>m.type.name!=='fontSize'),mark]);
 });
}
