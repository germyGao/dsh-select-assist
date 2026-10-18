/**
 * 朗读（Windows SAPI，进程内 COM，不起额外进程）。
 *
 * 用 ISpVoice：\`Speak(text, SPF_ASYNC|SPF_PURGEBEFORESPEAK)\` 异步朗读，
 * \`WaitUntilDone(0)\` 轮询是否还在读（S_OK=读完了，S_FALSE=还在读），
 * 再次点击时就 \`Speak('', SPF_PURGEBEFORESPEAK)\` 打断。
 *
 * vtable 槽位按 sapi.idl 的继承顺序数：IUnknown 0-2 → ISpNotifySource 3-9 →
 * ISpEventSource 10-12 → ISpVoice 从 13 起（SetOutput=13、SetVoice=18、Speak=20、
 * SetRate=28、SetVolume=30、WaitUntilDone=32）。槽位错一位就会崩进程，改之前先对 IDL。
 */
const CLSCTX_ALL = 0x17
const COINIT_APARTMENTTHREADED = 2

const CLSID_SpVoice = [0x96749377, 0x3391, 0x11d2, [0x9e, 0xe3, 0x00, 0xc0, 0x4f, 0x79, 0x73, 0x96]]
const IID_ISpVoice = [0x6c44df74, 0x72b9, 0x4992, [0xa1, 0xec, 0xef, 0x99, 0x6e, 0x04, 0x22, 0xd4]]
// SpObjectToken COM 类与 ISpObjectToken 接口。
const CLSID_SpObjectToken = [0xef411752, 0x3736, 0x4cb4, [0x9c, 0x8c, 0x8e, 0xf4, 0xcc, 0xb5, 0x8e, 0xfe]]
const IID_ISpObjectToken = [0x14056589, 0xe16c, 0x11d2, [0xbb, 0x90, 0x00, 0xc0, 0x4f, 0x8e, 0xe6, 0xc0]]
// SAPI 声音注册表主键：OneCore 优先（Windows 10+ 包含 Huihui/Kangkang/Yaoyao 等中文声音），
// 旧版 SAPI 5.4 才有 Zira（英文）。
const SPCAT_VOICES_ONECORE = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices'
const SPCAT_VOICES_LEGACY = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices'
// 简中语言 ID = 0x0804。
const LANG_ZH_CN = '804'

/** ISpVoice vtable 槽位。 */
const SLOT = {
  release: 2,
  setVoice: 18,
  speak: 20,
  setRate: 28,
  setVolume: 30,
  waitUntilDone: 32,
}

/** ISpObjectToken vtable 槽位（IUnknown 0-2 + ISpDataKey 3-14 + ISpObjectToken 15+）。 */
const TOKEN_SLOT = {
  release: 2,
  setId: 15,
}

/** SPF_ASYNC | SPF_PURGEBEFORESPEAK */
const SPEAK_ASYNC = 0x1
const SPEAK_PURGE = 0x2

/** koffi 类型是全局的：只建一次。 */
let cached = null

function bindings(koffi) {
  if (cached !== null) return cached
  const GUID = koffi.struct('DST_SP_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8 [8]' })
  const ole32 = koffi.load('ole32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  cached = {
    koffi,
    GUID,
    advapi32,
    proto: {
      speak: koffi.proto('int __stdcall DstSpSpeak(void *self, const char16_t *text, uint32_t flags, _Out_ uint32_t *stream)'),
      setRate: koffi.proto('int __stdcall DstSpSetRate(void *self, int rate)'),
      setVolume: koffi.proto('int __stdcall DstSpSetVolume(void *self, uint16_t volume)'),
      waitUntilDone: koffi.proto('int __stdcall DstSpWaitUntilDone(void *self, uint32_t ms)'),
      setVoice: koffi.proto('int __stdcall DstSpSetVoice(void *self, void *token)'),
      release: koffi.proto('uint32 __stdcall DstSpRelease(void *self)'),
      // ISpObjectToken
      tokenSetId: koffi.proto('int __stdcall DstTokenSetId(void *self, const char16_t *category, const char16_t *tokenId, int createIfNotExist)'),
      tokenRelease: koffi.proto('uint32 __stdcall DstTokenRelease(void *self)'),
      // 注册表：HKEY_LOCAL_MACHINE = 0x80000002；KEY_READ = 0x20019。
      regOpenKeyExW: advapi32.func('int __stdcall RegOpenKeyExW(void *hkey, const char16_t *subKey, uint32_t options, uint32_t samDesired, _Out_ void **result)'),
      regCloseKey: advapi32.func('int __stdcall RegCloseKey(void *hkey)'),
      regQueryInfoKeyW: advapi32.func('int __stdcall RegQueryInfoKeyW(void *hkey, void *classBuf, _Inout_ uint32_t *classLen, void *reserved, _Out_ uint32_t *subKeyCount, _Out_ uint32_t *maxSubKeyLen, _Out_ uint32_t *maxClassLen, _Out_ uint32_t *valueCount, _Out_ uint32_t *maxValueLen, _Out_ uint32_t *maxValueData, _Out_ uint32_t *securityDesc, void *lastWriteTime)'),
      regEnumKeyExW: advapi32.func('int __stdcall RegEnumKeyExW(void *hkey, uint32_t index, _Out_ char16_t *name, _Inout_ uint32_t *nameLen, void *reserved, void *classBuf, void *classLen, void *lastWriteTime)'),
      regOpenSubKeyW: advapi32.func('int __stdcall RegOpenKeyExW(void *hkey, const char16_t *subKey, uint32_t options, uint32_t samDesired, _Out_ void **result)'),
      regQueryValueExW: advapi32.func('int __stdcall RegQueryValueExW(void *hkey, const char16_t *valueName, void *reserved, void *type, _Out_ uint8_t *data, _Inout_ uint32_t *dataLen)'),
    },
  }
  cached.coInitializeEx = ole32.func('int __stdcall CoInitializeEx(void *reserved, uint32_t coinit)')
  cached.coCreateInstance = ole32.func('int __stdcall CoCreateInstance(DST_SP_GUID *clsid, void *outer, uint32_t ctx, DST_SP_GUID *iid, _Out_ void **out)')
  return cached
}

/** GUID 数组 → koffi 结构体。 */
function guidOf(parts) {
  return { Data1: parts[0], Data2: parts[1], Data3: parts[2], Data4: parts[3] }
}

/** 取接口的 vtable 槽位函数指针。 */
function slot(b, iface, index) {
  const vtable = b.koffi.decode(iface, 'void *')
  return b.koffi.decode(vtable, index * 8, 'void *')
}

/** 调一个 COM 方法（自动补 self）。 */
function invoke(b, iface, index, proto, ...args) {
  return b.koffi.call(slot(b, iface, index), proto, iface, ...args)
}

/** 读 HKLM\<path>\Tokens\<tokenId>\Attributes\Language；不存在/读不出返回 null。 */
function readLanguage(b, tokenId) {
  const subPath = `SOFTWARE\\Microsoft\\Speech_OneCore\\Voices\\Tokens\\${tokenId}\\Attributes`
  const hkey = [null]
  if (b.proto.regOpenKeyExW(null, subPath, 0, 0x20019, hkey) !== 0 || hkey[0] === null) return null
  try {
    // 先问长度
    const len = [64]
    const probe = b.koffi.alloc('uint8_t', 64)
    if (b.proto.regQueryValueExW(hkey[0], 'Language', null, null, probe, len) !== 0) {
      b.koffi.free(probe)
      return null
    }
    const buf = b.koffi.decode(probe, 'char16_t', Math.floor(len[0] / 2))
    b.koffi.free(probe)
    // 去尾零
    let s = ''
    for (const c of buf) if (c === 0) break; else s += String.fromCharCode(c)
    return s
  } finally {
    b.proto.regCloseKey(hkey[0])
  }
}

/**
 * 枚举 Voices\Tokens 子键，挑语言匹配（默认简中）的 token id。
 * @param b - 已加载的 bindings。
 * @param voiceCategory - OneCore 主键路径（不含 HKEY 前缀）。
 * @param preferLanguage - 简中 '804'；找不到回落任意第一个。
 */
function pickTokenId(b, voiceCategory, preferLanguage) {
  const hkey = [null]
  if (b.proto.regOpenKeyExW(null, voiceCategory, 0, 0x20019, hkey) !== 0 || hkey[0] === null) return null
  try {
    const out = { subKeyCount: [0], maxSubKeyLen: [0], maxClassLen: [0], valueCount: [0], maxValueLen: [0], maxValueData: [0] }
    const query = b.proto.regQueryInfoKeyW
    const ok = query(hkey[0], null, null, null, out.subKeyCount, out.maxSubKeyLen, out.maxClassLen, out.valueCount, out.maxValueLen, out.maxValueData, null, null)
    if (ok !== 0) return null
    const count = out.subKeyCount[0]
    if (count === 0) return null
    const nameLen = (out.maxSubKeyLen[0] | 0) + 2
    let first = null
    for (let i = 0; i < count; i++) {
      const nameBuf = b.koffi.alloc('char16_t', nameLen)
      const size = [nameLen]
      const enumFn = b.proto.regEnumKeyExW
      if (enumFn(hkey[0], i, nameBuf, size, null, null, null, null) !== 0) {
        b.koffi.free(nameBuf)
        continue
      }
      const chars = b.koffi.decode(nameBuf, 'char16_t', size[0])
      b.koffi.free(nameBuf)
      let tokenId = ''
      for (const c of chars) if (c === 0) break; else tokenId += String.fromCharCode(c)
      if (first === null) first = tokenId
      const lang = readLanguage(b, tokenId)
      if (lang === preferLanguage) return tokenId
    }
    return first
  } finally {
    b.proto.regCloseKey(hkey[0])
  }
}

/**
 * 建立一个 SpObjectToken 并 SetId(category, tokenId)。失败返回 null。
 * 调用方负责用完调 tokenRelease(token)。
 */
function createToken(b, categoryPath, tokenId) {
  const out = [null]
  const hr = b.coCreateInstance(guidOf(CLSID_SpObjectToken), null, CLSCTX_ALL, guidOf(IID_ISpObjectToken), out)
  if (hr !== 0 || out[0] === null) return null
  const token = out[0]
  const setHr = invoke(b, token, TOKEN_SLOT.setId, b.proto.tokenSetId, categoryPath, tokenId, 0)
  if (setHr !== 0) {
    invoke(b, token, TOKEN_SLOT.release, b.proto.tokenRelease)
    return null
  }
  return token
}

/**
 * 建立朗读器（懒建 COM 对象：不用就不初始化）。
 * @param koffi - 已解析到的 koffi 模块。
 * @returns \`{ speak, stop, isSpeaking, available, dispose }\`；COM 不可用时 available=false。
 */
export function createSpeaker(koffi) {
  const b = bindings(koffi)
  const created = b.coInitializeEx(null, COINIT_APARTMENTTHREADED)
  if (created !== 0 && created !== 1 && created !== -2147417850) return null
  let voice = null
  let failed = false

  /** 懒建 ISpVoice + 选中文声音（一次性）。 */
  const ensure = () => {
    if (voice !== null || failed) return voice
    const out = [null]
    const hr = b.coCreateInstance(guidOf(CLSID_SpVoice), null, CLSCTX_ALL, guidOf(IID_ISpVoice), out)
    if (hr !== 0 || out[0] === null) {
      failed = true
      return null
    }
    voice = out[0]
    // 默认偏快：让中文听起来更从容一些（-1 = 略慢，0 = SAPI 默认）。
    invoke(b, voice, SLOT.setRate, b.proto.setRate, -1)
    // 选中文声音：OneCore 优先，失败回落旧 SAPI 主键。
    const oneCore = pickTokenId(b, SPCAT_VOICES_ONECORE, LANG_ZH_CN)
    const chosen = oneCore ?? pickTokenId(b, SPCAT_VOICES_LEGACY, LANG_ZH_CN)
    if (chosen !== null) {
      const categoryPath = oneCore !== null ? SPCAT_VOICES_ONECORE : SPCAT_VOICES_LEGACY
      const token = createToken(b, categoryPath, chosen)
      if (token !== null) {
        invoke(b, voice, SLOT.setVoice, b.proto.setVoice, token)
        invoke(b, token, TOKEN_SLOT.release, b.proto.tokenRelease)
      }
    }
    return voice
  }

  return {
    /** 朗读一段文本（会打断上一次）。 */
    speak(text) {
      const voice = ensure()
      if (voice === null) return false
      const content = String(text ?? '').trim()
      if (content === '') return false
      const stream = [0]
      // 先清空当前队列再说话（连点两次 = 重新读）
      const hr = invoke(b, voice, SLOT.speak, b.proto.speak, content, SPEAK_ASYNC | SPEAK_PURGE, stream)
      return hr === 0
    },
    /** 立刻停下。 */
    stop() {
      const voice = ensure()
      if (voice === null) return
      const stream = [0]
      invoke(b, voice, SLOT.speak, b.proto.speak, '', SPEAK_PURGE, stream)
    },
    /** 是否还在读（S_FALSE=1 表示还在读）。 */
    isSpeaking() {
      if (voice === null) return false
      try {
        return invoke(b, voice, SLOT.waitUntilDone, b.proto.waitUntilDone, 0) === 1
      } catch {
        return false
      }
    },
    /** 语速（-10..10，0 为默认）。 */
    setRate(rate) {
      const voice = ensure()
      if (voice === null) return false
      return invoke(b, voice, SLOT.setRate, b.proto.setRate, Math.max(-10, Math.min(10, Math.round(rate)))) === 0
    },
    /** 音量（0..100）。 */
    setVolume(volume) {
      const voice = ensure()
      if (voice === null) return false
      return invoke(b, voice, SLOT.setVolume, b.proto.setVolume, Math.max(0, Math.min(100, Math.round(volume)))) === 0
    },
    available: () => ensure() !== null,
    dispose() {
      if (voice === null) return
      const dying = voice
      voice = null
      try {
        invoke(b, dying, SLOT.release, b.proto.release)
      } catch {
        /* 释放失败忽略 */
      }
    },
  }
}
