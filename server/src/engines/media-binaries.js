// 统一解析 ffmpeg / ffprobe 可执行文件的绝对路径。
//
// 为什么需要这个模块：API 服务由 launchd 启动时 PATH 只有
// /usr/local/bin:/usr/bin:/bin，而 Apple Silicon 的 Homebrew 把 ffmpeg
// 装在 /opt/homebrew/bin，导致 spawn('ffprobe') 直接 ENOENT。
// 各引擎统一走这里拿绝对路径：环境变量优先，其次 PATH，
// 最后补测标准安装目录；全部失败返回 null，由调用方给出可操作的中文错误。
import fs from "node:fs";
import path from "node:path";

// launchd 场景下 PATH 缺失时补测的标准安装目录（按命中概率排序）。
export const MEDIA_BINARY_FALLBACK_DIRECTORIES = Object.freeze([
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
]);

const ENV_VARIABLE_BY_BINARY = Object.freeze({
  ffmpeg: "FFMPEG_PATH",
  ffprobe: "FFPROBE_PATH",
});

// 探测涉及多次文件系统访问；结果按二进制名做进程内缓存，避免每个任务重复探测。
const resolutionCache = new Map();

function defaultIsExecutable(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 PATH 拆成目录列表并追加标准安装目录。
 * 空项/相对项会被服务进程的 cwd 影响，直接丢弃，保持 fail-closed。
 */
export function mediaBinarySearchDirectories(
  pathEnv,
  fallbackDirectories = MEDIA_BINARY_FALLBACK_DIRECTORIES,
) {
  const directories = String(pathEnv || "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter((value) => value && path.isAbsolute(value));
  return [...new Set([...directories, ...fallbackDirectories])];
}

function resolveBinary(binaryName, options = {}) {
  const {
    env = process.env,
    pathEnv,
    directories,
    isExecutable = defaultIsExecutable,
  } = options;
  // 只有全默认参数的调用才读写缓存；测试注入的 env / 目录列表不能污染进程级结果。
  const usingDefaults =
    env === process.env &&
    pathEnv === undefined &&
    directories === undefined &&
    isExecutable === defaultIsExecutable;
  if (usingDefaults && resolutionCache.has(binaryName)) {
    return resolutionCache.get(binaryName);
  }

  let resolved = null;
  // 环境变量优先，但必须真实存在且可执行；无效配置继续走目录探测，
  // 最终探测不到返回 null（不抛异常），由调用方转成可操作错误。
  const configured = String(env?.[ENV_VARIABLE_BY_BINARY[binaryName]] || "").trim();
  if (configured && path.isAbsolute(configured) && isExecutable(configured)) {
    resolved = path.normalize(configured);
  }
  if (!resolved) {
    const searchList =
      directories ??
      mediaBinarySearchDirectories(pathEnv === undefined ? env?.PATH : pathEnv);
    for (const directory of searchList) {
      const candidate = path.join(String(directory), binaryName);
      if (isExecutable(candidate)) {
        resolved = candidate;
        break;
      }
    }
  }

  if (usingDefaults) resolutionCache.set(binaryName, resolved);
  return resolved;
}

/** 解析 ffmpeg 绝对路径；找不到返回 null。 */
export function resolveFfmpeg(options) {
  return resolveBinary("ffmpeg", options);
}

/** 解析 ffprobe 绝对路径；找不到返回 null。 */
export function resolveFfprobe(options) {
  return resolveBinary("ffprobe", options);
}

/** 统一的可操作中文错误文案，供各调用方在解析失败时使用。 */
export function missingMediaBinaryMessage(binaryName) {
  const envName = ENV_VARIABLE_BY_BINARY[binaryName] || "FFMPEG_PATH";
  return `未找到 ${binaryName}：请安装 ffmpeg（brew install ffmpeg）或设置 ${envName} 环境变量`;
}

/** 清空进程内缓存；仅测试需要（环境变量变化后重新探测）。 */
export function resetMediaBinaryCache() {
  resolutionCache.clear();
}
