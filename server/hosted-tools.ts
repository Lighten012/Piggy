export const hostedTools = [
  {type:"code_interpreter", description:"生成和处理 Excel、PowerPoint 等文件。"},
  {type:"image_generation", description:"生成图片并作为回复附件发送。"},
  {type:"web_search", description:"联网查询新闻和最新资料，并在回答中引用来源。"},
];

export function responseTools(ids: string[]) {
  return hostedTools.map(({type}) => {
    if (type === "code_interpreter") return {type,container:{type:"auto",...(ids.length ? {file_ids:[...new Set(ids)]} : {})}};
    if (type === "image_generation") return {type,output_format:"jpeg",quality:"medium"};
    return {type};
  });
}
