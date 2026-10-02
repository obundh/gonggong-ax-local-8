const stopLabels = {
  'end-of-ranges': '선택 범위 검사 종료',
  'scan-byte-limit': '설정한 검색량에 도달했어요',
  'output-byte-limit': '설정한 추출 저장량에 도달했어요',
  'candidate-limit': '후보 개수 한도에 도달했어요',
  cancelled: '사용자가 검색을 중단했어요',
  'source-changed': '원본 상태가 달라져 중단했어요',
  error: '오류로 검색을 중단했어요',
};

export function deepCoverageView(coverage) {
  if (coverage?.strategy !== 'carving') return null;
  const { selectedBytes, examinedBytes, unexaminedBytes, readErrorBytes } = coverage;
  if (![selectedBytes, examinedBytes, unexaminedBytes, readErrorBytes].every(v => Number.isSafeInteger(v) && v >= 0)
      || examinedBytes > selectedBytes || examinedBytes + unexaminedBytes !== selectedBytes) return null;
  return {
    selectedBytes, examinedBytes, unexaminedBytes, readErrorBytes,
    percent: selectedBytes ? examinedBytes / selectedBytes * 100 : null,
    incomplete: coverage.complete !== true || unexaminedBytes > 0 || readErrorBytes > 0,
    label: coverage.stopReason === 'end-of-ranges' && coverage.complete !== true
      ? '선택 범위 검사 종료 · 확인 필요' : stopLabels[coverage.stopReason] || '파일 흔적을 확인하고 있어요',
  };
}

export function deepSearchLimits(profile) {
  if (profile === 'small') return { maxScanBytes: 1024 ** 3, maxOutputBytes: 256 * 1024 ** 2 };
  if (profile === 'medium') return { maxScanBytes: 4 * 1024 ** 3, maxOutputBytes: 1024 ** 3 };
  return undefined;
}
