import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'artifacts/native-chat-live-2026-09-06');
const destination = path.join(os.homedir(), 'Desktop/数字员工对话创作实测-2026-09-06');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const href = file => file.split('/').map(encodeURIComponent).join('/');
const records = {};
fs.mkdirSync(destination, { recursive: true });
for (const [kind, folder] of [['xhs', '小红书种草员'], ['sales', 'AI带货员']]) {
  const from = path.join(source, 'retest', kind), to = path.join(destination, folder);
  const execution = read(path.join(from, 'execution.json'));
  if (!execution.success) throw new Error(`${kind}: final real acceptance not successful`);
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (name === '成品' || name.endsWith('.zip') || name.startsWith('输入照片-') ||
      ['01-用户输入.json', '02-首次回复与方案.json', '03-用户修改意见.json', '04-修改后方案.json', '05-确认生成回执.json', '08-打包下载核验.json', '09-真实API账本.json', 'execution.json', 'provider-http-evidence.json'].includes(name)) {
      fs.cpSync(path.join(from,name),path.join(to,name),{recursive:true});
    }
  }
  const final = read(path.join(from, '06-最终结果.json'));
  const request = read(path.join(from, '01-用户输入.json'));
  records[kind] = {folder,execution,final,request};
}
const analysis = fs.readdirSync(path.join(source,'retest/sales')).filter(name => name.startsWith('video-analysis-')).sort().at(-1);
const verification = read(path.join(source,'retest/sales',analysis,'verification.json'));
fs.copyFileSync(verification.contactSheet,path.join(destination,'AI带货员/成片抽帧核对.png'));
fs.writeFileSync(path.join(destination,'AI带货员/媒体核验.json'),JSON.stringify({video:verification.video,audio:verification.audio,checks:verification.checks,sha256:verification.input.sha256},null,2));
const note = records.xhs.final.final.output;
const images = fs.readdirSync(path.join(destination,'小红书种草员/成品/图片')).sort();
const text = `本轮已完成真实API对话创作验收。\n\nAI小红书种草员：六张Image2图片全部返回，封面为四张不同原图本地合成的四宫格；标题、正文、标签和首评可查看，ZIP已实际下载并解压核对。\nAI带货员：真实主题与两张照片→AI脚本→用户修改意见→确认脚本→两段Wan2.6→30秒竖屏成片。原生音轨存在、分段音量通过检查、8条中文字幕已烧录，14.8–15.2秒为0.4秒叠化。字幕按脚本估时，未做逐字语音识别；请播放检查配音与字幕细节。\n两岗重复点击确认都复用同一任务，确认后的文字/脚本与执行稿一致；对话恢复、任务中心正文、打包下载均实际核对。9/12图及其他风格有离线回归，未全部额外收费实测。\n\n首次测试的问题如实保留：第一次小红书完成4/6图，另外两次HTTP200只收到响应头，响应体到360秒中断，不能据此视作免费失败。第一次视频第2段提交在60秒超时；第1段已免费取回，第二段执行/账务仍待核对。代码已延长有界等待、保存完整回执并支持免费取回已生成素材。修复后本目录的新独立图文/视频测试全部交付；旧未知调用没有被伪装成功或退账。\n\n本目录都是实际API输入、输出和账本证据。测试使用正式配置与用户实拍，但在SQLite副本中执行；未修改正式账号、余额或任务历史。报告里的积分是应用计价记录，供应商发生了真实调用。\n\n使用示例已加入两个数字员工对话框；点击仅填入草稿，补充照片后发送，脚本和图文由数字员工完成。\n`;
fs.writeFileSync(path.join(destination,'先看这里.txt'),text);
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数字员工对话创作 · 真实API实测</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f4f0;color:#26241f;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;line-height:1.8}main{max-width:1120px;margin:auto;padding:48px 24px}h1{font-size:32px;line-height:1.35;margin:12px 0}h2{font-size:24px;margin:0 0 20px}h3{font-size:19px}p{margin:12px 0}.eyebrow{font-size:13px;letter-spacing:2px;color:#77654c}.intro{max-width:800px;color:#625d54}.pill{display:inline-block;padding:4px 12px;border:1px solid #c9c8b4;border-radius:100px;background:#edf1e7;margin:4px 6px 4px 0;font-size:13px}section{margin-top:40px;padding:28px;background:#fff;border:1px solid #e6e0d8;border-radius:12px}.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px}a{color:#65471e}a.button{display:inline-block;background:#343b2e;color:#fff;text-decoration:none;border-radius:7px;padding:10px 18px;margin:8px 10px 8px 0}.copy{white-space:pre-wrap;line-height:1.95;font-size:17px}video{display:block;width:100%;max-height:640px;background:#181818;border-radius:8px}.photos,.images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.photos{grid-template-columns:repeat(2,minmax(0,1fr))}.images img{width:100%;display:block;border-radius:7px}.photos img{width:100%;height:220px;object-fit:cover;border-radius:7px}figure{margin:0}figcaption{font-size:13px;color:#746b60;margin-top:6px}details{margin-top:20px;color:#625d54}summary{cursor:pointer}.notice{background:#fcf7ed;padding:16px;border-left:3px solid #c7a35a}.small{font-size:13px;color:#776e62}.frames{width:100%;max-width:900px} @media(max-width:700px){main{padding:24px 14px}section{padding:18px}.split{grid-template-columns:1fr}.images{grid-template-columns:repeat(2,minmax(0,1fr))}h1{font-size:26px}}
</style><main><div class="eyebrow">纳米WORK · 数字员工</div><h1>照片和一句主题，交给员工完成</h1><p class="intro">这是本轮真实API实测产物。两岗都通过聊天写稿、修改后确认生成，可预览、复制和一键打包下载。对话框已加入可点击的使用示例。</p><span class="pill">Image2 · 6 / 6张</span><span class="pill">Wan2.6 · 30秒</span><span class="pill">确认稿复用核验通过</span><span class="pill">ZIP下载核验通过</span>
<section><h2>这次的真实输入</h2><div class="split"><div class="photos">${[2,3].map(id=>`<figure><img src="${href(`小红书种草员/输入照片-${id}.jpg`)}" alt="用户${id===2?'门头':'菜品'}实拍"><figcaption>用户${id===2?'门头':'菜品'}实拍</figcaption></figure>`).join('')}</div><div><h3>品牌：罗二火锅</h3><p>主题：下班约朋友来吃火锅。</p><p>小红书：六图种草，四宫格封面，品牌招呼顾客的语气。</p><p>带货视频：菜品接门头、自然中文女声与字幕。脚本由AI写，再按聊天意见修改。</p><details><summary>查看完整实际输入</summary><p class="copy">${esc(records.xhs.request.message)}</p><hr><p class="copy">${esc(records.sales.request.message)}</p></details></div></div></section>
<section><h2>AI小红书种草员</h2><a class="button" download href="${href('小红书种草员/小红书六图与文案.zip')}">下载六图与文案ZIP</a><div class="split"><div><h3>${esc(note.title)}</h3><div class="copy">${esc(note.body)}</div><p>${esc((note.tags||[]).map(tag=>'#'+tag.replace(/^#+/,'')).join(' '))}</p><p><strong>首评</strong>：${esc(note.firstComment)}</p><p class="small">文案为模型原输出，发布前由老板检查并选择是否采纳。</p></div><div><img style="width:100%;max-height:570px;object-fit:contain" src="${href('小红书种草员/成品/图片/'+images[0])}" alt="真实生成四宫格封面"></div></div><h3>六张成品</h3><div class="images">${images.map(file=>`<figure><a href="${href('小红书种草员/成品/图片/'+file)}"><img loading="lazy" src="${href('小红书种草员/成品/图片/'+file)}" alt="${esc(file)}"></a><figcaption>${esc(file.replace('.png',''))}</figcaption></figure>`).join('')}</div></section>
<section><h2>AI带货员</h2><div class="split"><div><video controls preload="metadata" src="${href('AI带货员/成品/带货视频.mp4')}"></video></div><div><h3>30秒竖屏成片</h3><p>1080 × 1920 · 30fps · 两段Wan2.6原生有声视频。</p><p>中文字幕已烧录；中间采用0.4秒叠化，保留30秒总时长。</p><a class="button" download href="${href('AI带货员/带货视频与脚本.zip')}">下载视频与脚本ZIP</a><p><a href="${href('AI带货员/成品/视频脚本.txt')}">查看实际确认脚本</a></p><p class="small">音轨及分段音量已检查。字幕按脚本估时，未做逐字语音识别；请播放核对声音、品牌和字幕细节。</p></div></div><details><summary>查看第2、12、22秒抽帧</summary><img class="frames" src="${href('AI带货员/成片抽帧核对.png')}" alt="真实成片抽帧"></details></section>
<section><h2>测试记录与限制</h2><p>本次成功样本实际调用了六次Image2与两段Wan2.6；文字改稿、原文复用、重复确认、历史查看和打包下载均留有证据。9/12图和其他风格完成离线回归，没有声称全部收费实测。</p><div class="notice">第一轮曾出现两张图片响应体超时和视频第二段提交超时。成功成果均保留；原未知费用没有被当成免费失败。修复后进行了本目录这次独立复测，六图和30秒视频均完整交付。</div><p class="small">测试数据库与正式历史隔离。图片是AI创意配图，非实拍；视频由用户实拍驱动生成。</p><p><a href="先看这里.txt">完整验收说明</a> · <a href="${href('小红书种草员/09-真实API账本.json')}">图文调用账本</a> · <a href="${href('AI带货员/09-真实API账本.json')}">视频调用账本</a></p><p class="small">封面设计参考：<a href="https://www.designkit.cn/article/xhsmstdfmsjrhtsssdjl20250715">美图设计室美食封面思路</a>。不承诺平台流量或自动发布。</p></section></main></html>`;
fs.writeFileSync(path.join(destination,'打开实测结果.html'),html);
console.log(JSON.stringify({destination,files:fs.readdirSync(destination),xhsImages:images.length,videoSeconds:verification.video.durationSeconds}));
