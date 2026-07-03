// Best-effort client-side OS detection, shared by download-page components.
// Returns: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'unknown'.
export function detectOS() {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent || ''
  const plat = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()
  if (plat.includes('win') || /Windows/i.test(ua)) return 'windows'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (plat.includes('mac') || /Mac OS X/i.test(ua)) return 'macos'
  if (/Android/i.test(ua)) return 'android'
  if (plat.includes('linux') || /Linux|X11/i.test(ua)) return 'linux'
  return 'unknown'
}
