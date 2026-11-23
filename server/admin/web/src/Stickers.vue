<script setup>
import {onMounted, ref} from "vue";
const items=ref([]), editing=ref(null), name=ref(""), description=ref(""), file=ref(null);
const picker=ref(null), busy=ref(false), notice=ref(""), error=ref("");
async function request(url,options) {
  const res=await fetch(url,options);
  if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error || "请求失败，请重试");
  return res.json();
}
async function load(){items.value=await request("/stickers");}
onMounted(()=>load().catch(e=>error.value=e.message));
function edit(item) {
  editing.value=item;name.value=item?.name ?? "";description.value=item?.description ?? "";
  file.value=null;if(picker.value) picker.value.value="";error.value="";notice.value="";
}
async function encode(image) {
  if(!image || !["image/png","image/jpeg","image/webp"].includes(image.type) || image.size>8*1024*1024)
    throw new Error("请选择 8 MB 以内的 PNG、JPEG 或 WebP");
  const bitmap=await createImageBitmap(image);
  try {
    const ratio=Math.min(1,480/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
    canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  } finally {bitmap.close();}
}
async function save(item,active) {
  if(busy.value)return;
  busy.value=true;error.value="";notice.value="";
  try {
    const toggling=typeof active==="boolean";
    const body=toggling?{name:item.name,description:item.description,active}:{name:name.value.trim(),description:description.value.trim()};
    if(!item) body.image=await encode(file.value);
    else if(!toggling) body.active=Boolean(item.active);
    await request(item?"/stickers/"+item.id:"/stickers",{method:item?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    await load();edit(null);notice.value=toggling?(active?"已上架":"已下架，历史消息仍可查看"):"已保存";
  } catch(e){error.value=e.message;} finally {busy.value=false;}
}
</script>
<template>
  <section aria-labelledby="stickers-title">
    <h2 id="stickers-title">表情库</h2>
    <ul v-if="items.length" class="stickers">
      <li v-for="item in items" :key="item.id">
        <img :src="'/stickers/'+item.id" :alt="item.name" loading="lazy">
        <div><strong>{{ item.name }}</strong><span v-if="!item.active"> · 已下架</span><p>{{ item.description }}</p>
          <button type="button" :disabled="busy" @click="edit(item)">编辑</button>
          <button type="button" :disabled="busy" @click="save(item,!item.active)">{{ item.active?'下架':'上架' }}</button>
        </div>
      </li>
    </ul>
    <form @submit.prevent="save(editing)">
      <fieldset :disabled="busy"><legend>{{ editing?'编辑表情':'添加表情' }}</legend>
        <label v-if="!editing">图片<input ref="picker" type="file" accept="image/png,image/jpeg,image/webp" required @change="file=$event.target.files[0]"></label>
        <label>名称<input v-model.trim="name" maxlength="24" required placeholder="例如：小猪探头"></label>
        <label>什么时候发<input v-model.trim="description" maxlength="96" required placeholder="例如：她刚回来，想俏皮地打个招呼"></label>
        <div><button type="submit">{{ editing?'保存修改':'添加并上架' }}</button> <button v-if="editing" type="button" @click="edit(null)">取消</button></div>
      </fieldset>
    </form>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>
<style scoped>
.stickers{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(235px,100%),1fr));gap:12px}
li{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid #ded9e2;border-radius:14px}
li img{width:72px;height:72px;object-fit:contain}li p{margin:4px 0;color:#514a58}
fieldset{display:grid;gap:10px;border:1px solid #ded9e2;border-radius:12px;padding:14px}label{display:grid;gap:4px}input{font:inherit;padding:8px;max-width:100%;box-sizing:border-box}
button{cursor:pointer;font:inherit;padding:6px 10px;border:1px solid #d3c9dc;border-radius:9px;background:white;color:#554560;margin-right:4px}
[role=alert]{color:#922f40}
</style>
