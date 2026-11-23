import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import type {IncomingMessage, ServerResponse} from "node:http";
import type {DatabaseSync} from "node:sqlite";
import {PNG} from "pngjs";
import type {AgentTool} from "@earendil-works/pi-agent-core";

const maxBytes=1024*1024;
const maxActive=64;
export const stickerId=/^[a-f0-9]{24}$/;
interface Sticker { id:string; name:string; description:string; active:number }
function label(value:unknown,max:number) {
  if(typeof value!=="string" || !value.trim() || [...value.trim()].length>max || /[\p{Cc}]/u.test(value))
    throw new Error("请填写有效的名称（最多 24 字）和使用说明（最多 96 字）");
  return value.trim();
}

export class StickerLibrary {
  private db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec("CREATE TABLE IF NOT EXISTS stickers(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,active INTEGER NOT NULL,image BLOB NOT NULL)");
  }
  seed(directory:URL) {
    this.db.exec("CREATE TABLE IF NOT EXISTS sticker_seeds(version INTEGER PRIMARY KEY)");
    if(this.db.prepare("SELECT 1 FROM sticker_seeds WHERE version=1").get()) return;
    const entries=JSON.parse(readFileSync(new URL("index.json",directory),"utf8"));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for(const entry of entries) this.add(entry.name,entry.description,readFileSync(new URL(entry.file,directory)));
      this.db.prepare("INSERT INTO sticker_seeds VALUES(1)").run();
      this.db.exec("COMMIT");
    } catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  list(activeOnly=false) {
    return this.db.prepare("SELECT id,name,description,active FROM stickers"+(activeOnly?" WHERE active=1":"")+" ORDER BY rowid").all() as unknown as Sticker[];
  }
  image(id:string) { return this.db.prepare("SELECT image FROM stickers WHERE id=?").get(id)?.image as Uint8Array|undefined; }
  available(id:string) { return !!this.db.prepare("SELECT 1 FROM stickers WHERE id=? AND active=1").get(id); }
  private checkCapacity() {
    if(Number(this.db.prepare("SELECT count(*) AS n FROM stickers WHERE active=1").get()!.n)>=maxActive)
      throw new Error("最多可同时上架 64 张表情");
  }
  add(name:unknown,description:unknown,bytes:Buffer) {
    const title=label(name,24), usage=label(description,96);
    this.checkCapacity();
    if(bytes.length<33 || bytes.length>maxBytes || bytes.toString("hex",0,8)!=="89504e470d0a1a0a" ||
        bytes.toString("ascii",12,16)!=="IHDR" || bytes.readUInt32BE(16)>512 || bytes.readUInt32BE(20)>512)
      throw new Error("请使用 512 像素以内的 PNG 表情");
    let image:Buffer;
    try { image=PNG.sync.write(PNG.sync.read(bytes)); }
    catch { throw new Error("图片无法读取"); }
    const id=createHash("sha256").update(image).digest("hex").slice(0,24);
    if(this.db.prepare("SELECT 1 FROM stickers WHERE id=?").get(id)) throw new Error("图片已在表情库中，可直接编辑或重新上架");
    this.db.prepare("INSERT INTO stickers VALUES(?,?,?,1,?)").run(id,title,usage,image);
    return id;
  }
  edit(id:string,name:unknown,description:unknown,active:unknown) {
    const title=label(name,24), usage=label(description,96);
    if(typeof active!=="boolean") throw new Error("无效的上架状态");
    if(active && !this.available(id)) this.checkCapacity();
    if(!this.db.prepare("UPDATE stickers SET name=?,description=?,active=? WHERE id=?").run(title,usage,Number(active),id).changes)
      throw new Error("表情不存在");
  }
}

export const stickerDeclaration={name:"send_sticker",description:"选取表情库中的一张贴在本轮回复末尾。only=true 表示只发表情。",parameters:{type:"object",properties:{
  id:{type:"string",description:"从当前上架列表选取的表情 ID"},only:{type:"boolean",description:"本轮是否只发表情而不显示文字"}},required:["id","only"],additionalProperties:false}} as const;

export function stickerTool(library:StickerLibrary, select:(id:string,only:boolean)=>void):AgentTool {
  let chosen:string|undefined;
  return {...stickerDeclaration,label:"发送表情",executionMode:"sequential",async execute(_call,params){
    const {id,only}=params as {id:string;only:boolean};
    if(chosen && chosen!==id) throw new Error("本轮已选好表情，无需再选");
    if(!library.available(id)) throw new Error("该表情已下架或不存在");
    if(!chosen){select(id,only);chosen=id;}
    return {content:[{type:"text",text:"表情已选好，会随本轮回复一起送达。"}],details:{id}};
  }};
}

export async function stickerRequest(library:StickerLibrary,req:IncomingMessage,res:ServerResponse,path:string,admin:boolean) {
  const id=path.slice("/stickers/".length);
  const json=(code:number,value:unknown)=>{res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(value));};
  if(stickerId.test(id) && (req.method==="GET" || req.method==="HEAD")) {
    const data=library.image(id);
    if(!data) return json(404,{error:"表情不存在"});
    res.writeHead(200,{"Content-Type":"image/png","Content-Length":data.byteLength,"Cache-Control":"private, max-age=31536000, immutable"});
    res.end(req.method==="HEAD"?undefined:data);return;
  }
  if(!admin) return json(404,{error:"表情不存在"});
  if(req.method==="GET" && path==="/stickers") return json(200,library.list());
  const upload=req.method==="POST" && path==="/stickers";
  if(!upload && !(req.method==="PUT" && stickerId.test(id))) return json(405,{error:"不支持此操作"});
  if(req.headers["content-type"]?.split(";")[0]!=="application/json") return json(415,{error:"请使用 JSON"});
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){
    size+=chunk.length;
    if(size>(upload?1450000:2048)) return json(413,{error:"图片或说明过大"});
    chunks.push(chunk);
  }
  try {
    const body=JSON.parse(Buffer.concat(chunks).toString());
    if(upload) {
      if(typeof body.image!=="string") throw new Error("请选择图片");
      return json(201,{id:library.add(body.name,body.description,Buffer.from(body.image,"base64"))});
    }
    library.edit(id,body.name,body.description,body.active);
    return json(200,{id});
  } catch(error) {return json(400,{error:error instanceof Error?error.message:"保存失败"});}
}
