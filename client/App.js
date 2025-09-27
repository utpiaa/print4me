import React, { useMemo, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, Alert, Platform, ActivityIndicator, ScrollView, KeyboardAvoidingView, Linking } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import Constants from 'expo-constants';
import axios from 'axios';
import * as FileSystem from 'expo-file-system';

const theme = {
  primary: '#2563eb',
  primaryDark: '#1d4ed8',
  danger: '#dc2626',
  bg: '#f8fafc',
  card: '#ffffff',
  text: '#0f172a',
  muted: '#64748b',
  border: '#e2e8f0',
};

function isValidEgyptMobile(mobile) {
  if (!mobile) return false;
  const trimmed = String(mobile).replace(/\s|-/g, '');
  const re = /^(?:\+?20|0020|0)?1[0125]\d{8}$/;
  return re.test(trimmed);
}

export default function App() {
  const apiBaseUrl = useMemo(() => {
    const extra = Constants?.expoConfig?.extra || Constants?.manifest?.extra || {};
    return extra.apiBaseUrl || 'http://localhost:4000';
  }, []);

  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState([]); // { name, size, mimeType, uri }
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);

  // Print options
  const [colorMode, setColorMode] = useState('color'); // 'color' | 'bw'
  const [paperSize, setPaperSize] = useState('A4'); // 'A4' | 'A3'
  const [sides, setSides] = useState('single'); // 'single' | 'double'
  const [copies, setCopies] = useState('1');
  // Auto pages detection state per file
  // files: [{ name, size, mimeType, uri, detectedPages, isPdf, selectMode, rangeFrom, rangeTo, manualPages }]

  const unitPrice = () => {
    if (colorMode === 'bw' && sides === 'single') return 1.0;
    if (colorMode === 'bw' && sides === 'double') return 1.5;
    if (colorMode === 'color' && sides === 'single') return 5.0;
    if (colorMode === 'color' && sides === 'double') return 7.0;
    return 1.0;
  };
  const totalDetectedPages = useMemo(() => {
    return files.reduce((sum, f) => {
      // manual override takes precedence if provided
      const manual = Number(f.manualPages || 0);
      if (manual > 0) return sum + manual;
      const max = Number(f.detectedPages || 0);
      if (!max) return sum;
      if (f.isPdf && f.selectMode === 'range') {
        const from = Math.max(1, Math.min(max, Number(f.rangeFrom || 1)));
        const to = Math.max(1, Math.min(max, Number(f.rangeTo || max)));
        const pages = Math.max(0, to - from + 1);
        return sum + pages;
      }
      return sum + max; // images and PDFs in 'all' mode
    }, 0);
  }, [files]);

  const totalPrice = () => {
    const c = Number(copies) || 0;
    const p = Number(totalDetectedPages) || 0;
    return +(unitPrice() * c * p).toFixed(2);
  };

  const pickFiles = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
        type: [
          'application/pdf',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'image/*',
        ],
      });

      if (res.canceled) return;

      const selected = res.assets || [];
      const mapped = selected.map((a) => ({
        name: a.name,
        size: a.size,
        mimeType: a.mimeType,
        uri: a.uri,
        detectedPages: undefined,
        isPdf: a.mimeType === 'application/pdf',
        selectMode: a.mimeType === 'application/pdf' ? 'all' : undefined,
        rangeFrom: '1',
        rangeTo: '1',
        manualPages: '',
      }));

      // limit to 5 files, 25MB each
      const limited = [...files, ...mapped].slice(0, 5);
      const tooBig = limited.find((f) => typeof f.size === 'number' && f.size > 25 * 1024 * 1024);
      if (tooBig) {
        Alert.alert('File too large', 'Each file must be 25MB or smaller.');
        return;
      }

      // Save first to update UI quickly
      setFiles(limited);

      // Auto-detect pages per file using /api/count-one for better reliability
      try {
        const withPages = [];
        for (let i = 0; i < limited.length; i++) {
          const f = limited[i];
          // Map ext and type
          const lowerName = (f.name || '').toLowerCase();
          const extMatch = lowerName.match(/\.([a-z0-9]+)$/);
          const ext = extMatch ? extMatch[1] : (f.mimeType === 'application/pdf' ? 'pdf' : 'bin');
          const type = f.mimeType || (ext === 'pdf' ? 'application/pdf' : 'application/octet-stream');
          // Copy to cache to ensure file:// path
          const dest = FileSystem.cacheDirectory + `upload_${Date.now()}_${i}.${ext}`;
          let useUri = f.uri;
          try {
            await FileSystem.copyAsync({ from: f.uri, to: dest });
            const info = await FileSystem.getInfoAsync(dest);
            if (info?.exists && info.size > 0) {
              useUri = dest; // file:// path
            }
          } catch (copyErr) {
            // Fall back to original URI
          }
          const fileUri = Platform.OS === 'ios'
            ? (useUri.startsWith('file://') ? useUri.replace('file://','') : useUri)
            : useUri; // keep file:// on Android
          const fd = new FormData();
          fd.append('file', { name: f.name || `file_${i}.${ext}`, type, uri: fileUri });
          const endpoint = apiBaseUrl.replace(/\/$/, '') + '/api/count-one';
          let detected = f.mimeType && f.mimeType.startsWith('image/') ? 1 : 0;
          try {
            const resp = await fetch(endpoint, { method: 'POST', body: fd });
            const txt = await resp.text();
            let data = {};
            try { data = JSON.parse(txt); } catch (_) {}
            if (data?.ok && typeof data.pages === 'number') {
              detected = data.pages;
            } else if (!resp.ok) {
              console.log('count-one failed', resp.status, txt);
            }
          } catch (e) {
            console.log('count-one network error', String(e));
          }
          withPages.push({
            ...f,
            detectedPages: detected,
            rangeTo: String(detected || 1),
            localPath: dest,
          });
        }
        setFiles(withPages);
      } catch (e) {
        // Non-fatal fallback; pages remain unset for manual entry
      }
    } catch (err) {
      Alert.alert('Picker error', err.message || String(err));
    }
  };

  const removeFile = (idx) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const submit = async () => {
    if (!name.trim()) return Alert.alert('Validation', 'Please enter your name.');
    if (!mobile.trim() || !isValidEgyptMobile(mobile)) return Alert.alert('Validation', 'Please enter a valid Egypt mobile number.');
    if (!address.trim()) return Alert.alert('Validation', 'Please enter your delivery address.');
    if (files.length === 0) return Alert.alert('Validation', 'Please select at least one file.');

    // validate copies
    const copiesNum = Number(copies);
    if (!copies || Number.isNaN(copiesNum) || copiesNum < 1 || copiesNum > 100) {
      return Alert.alert('Validation', 'Copies must be a number between 1 and 100.');
    }
    // calculate pages from detected/ranges
    const pagesNum = totalDetectedPages;
    if (!pagesNum || pagesNum < 1 || pagesNum > 10000) {
      return Alert.alert('Validation', 'Could not determine total pages. Please re-add files.');
    }

    const endpoint = apiBaseUrl.replace(/\/$/, '') + '/api/print-request';

    const data = new FormData();
    data.append('name', name);
    data.append('mobile', mobile);
    data.append('address', address);
    if (notes.trim()) data.append('notes', notes.trim());
    // append print options
    data.append('colorMode', colorMode);
    data.append('paperSize', paperSize);
    data.append('sides', sides);
    data.append('copies', String(copiesNum));
    // add per-file metadata for server-side ranges
    const filesMeta = files.map((f, i) => ({
      index: i,
      name: f.name,
      isPdf: !!f.isPdf,
      selectMode: f.isPdf ? f.selectMode : undefined,
      rangeFrom: f.isPdf && f.selectMode === 'range' ? Number(f.rangeFrom || 1) : undefined,
      rangeTo: f.isPdf && f.selectMode === 'range' ? Number(f.rangeTo || f.detectedPages || 1) : undefined,
    }));
    data.append('filesMeta', JSON.stringify(filesMeta));
    data.append('pages', String(pagesNum));

    files.forEach((f, i) => {
      const fileName = f.name || `file_${i}`;
      const type = f.mimeType || 'application/octet-stream';
      data.append('files', {
        name: fileName,
        type,
        uri: Platform.OS === 'ios' ? f.uri.replace('file://', '') : f.uri,
      });
    });

    try {
      setSubmitting(true);
      setProgress(0);
      // Prefer fetch for RN multipart reliability; axios can throw generic Network Error on Android
      const response = await fetch(endpoint, {
        method: 'POST',
        body: data,
        // Do not set headers; RN will set proper multipart boundary
      });
      const isJson = (response.headers.get('content-type') || '').includes('application/json');
      const payload = isJson ? await response.json() : { ok: false, error: await response.text() };

      if (payload?.ok) {
        Alert.alert('Success', 'Your print request was sent! We will contact you shortly.');
        setName('');
        setMobile('');
        setAddress('');
        setNotes('');
        setFiles([]);
        setProgress(0);
        setColorMode('color');
        setPaperSize('A4');
        setSides('single');
        setCopies('1');
      } else {
        const msg = payload?.errors?.join('\n') || payload?.error || `HTTP ${response.status}`;
        Alert.alert('Error', msg);
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.errors?.join('\n') || err.message || String(err);
      Alert.alert('Upload failed', msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 24, fontWeight: '700', color: theme.text, marginBottom: 12 }}>Print4me</Text>
        <Text style={{ color: theme.muted, marginBottom: 16 }}>
          Upload your files, enter your contact and delivery address. We'll print and deliver to you.
        </Text>

        <View style={{ backgroundColor: theme.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: theme.border, marginBottom: 12 }}>
          <Label>Full Name</Label>
          <Field value={name} onChangeText={setName} placeholder="e.g. Ahmed Ali" />

          <Label>Mobile Number (Egypt)</Label>
          <Field value={mobile} onChangeText={setMobile} placeholder="e.g. +2010XXXXXXXX" keyboardType="phone-pad" />

          <Label>Delivery Address</Label>
          <Field value={address} onChangeText={setAddress} placeholder="City, Area, Street, Building, Apt" multiline />

          <Label>Notes (optional)</Label>
          <Field value={notes} onChangeText={setNotes} placeholder="Any special instructions" multiline />
        </View>

        <View style={{ backgroundColor: theme.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: theme.border, marginBottom: 12 }}>
          <Text style={{ fontWeight: '600', color: theme.text, marginBottom: 8 }}>Print Options</Text>

          <Label>Color Mode</Label>
          <Segmented
            options={[{ key: 'color', label: 'Color' }, { key: 'bw', label: 'B/W' }]}
            value={colorMode}
            onChange={setColorMode}
          />

          <Label>Paper Size</Label>
          <Segmented
            options={[{ key: 'A4', label: 'A4' }, { key: 'A3', label: 'A3' }]}
            value={paperSize}
            onChange={setPaperSize}
          />

          <Label>Sides</Label>
          <Segmented
            options={[{ key: 'single', label: 'Single' }, { key: 'double', label: 'Double' }]}
            value={sides}
            onChange={setSides}
          />

          <Label>Copies</Label>
          <Field
            value={copies}
            onChangeText={setCopies}
            placeholder="1"
            keyboardType="number-pad"
          />

          <View style={{ marginTop: 8, padding: 10, borderRadius: 8, backgroundColor: '#f1f5f9', borderWidth: 1, borderColor: theme.border }}>
            <Text style={{ color: theme.text, fontWeight: '600' }}>Estimated Price</Text>
            <Text style={{ color: theme.muted }}>
              Unit: EGP {unitPrice()} • Copies: {copies || '0'} • Pages: {totalDetectedPages}
            </Text>
            <Text style={{ color: theme.primaryDark, fontSize: 18, fontWeight: '700' }}>Total: EGP {totalPrice()}</Text>
          </View>
        </View>

        <View style={{ backgroundColor: theme.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: theme.border, marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontWeight: '600', color: theme.text }}>Files ({files.length}/5)</Text>
            <PrimaryButton title="Add Files" onPress={pickFiles} />
          </View>
          <View style={{ marginTop: 8 }}>
            {files.map((item, index) => (
              <View key={item.uri + index} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1, paddingRight: 8 }}>
                    <Text numberOfLines={1} style={{ color: theme.text }}>{item.name}</Text>
                    <Text style={{ color: theme.muted, fontSize: 12 }}>{item.mimeType || 'file'} • Pages: {item.manualPages ? item.manualPages : (item.detectedPages ?? '?')}</Text>
                  </View>
                  <TouchableOpacity onPress={() => removeFile(index)}>
                    <Text style={{ color: theme.danger, fontWeight: '600' }}>Remove</Text>
                  </TouchableOpacity>
                </View>
                {item.isPdf ? (
                  <View style={{ marginTop: 6 }}>
                    <Segmented
                      options={[{ key: 'all', label: 'Whole file' }, { key: 'range', label: 'Range' }]}
                      value={item.selectMode}
                      onChange={(val) => {
                        setFiles((prev) => prev.map((f, i) => i === index ? { ...f, selectMode: val } : f));
                      }}
                    />
                    {item.selectMode === 'range' ? (
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Field
                            value={item.rangeFrom}
                            onChangeText={(t) => setFiles((prev) => prev.map((f, i) => i === index ? { ...f, rangeFrom: t } : f))}
                            placeholder="From"
                            keyboardType="number-pad"
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Field
                            value={item.rangeTo}
                            onChangeText={(t) => setFiles((prev) => prev.map((f, i) => i === index ? { ...f, rangeTo: t } : f))}
                            placeholder="To"
                            keyboardType="number-pad"
                          />
                        </View>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {/* Manual pages fallback if detection failed */}
                {(Number(item.detectedPages || 0) === 0) ? (
                  <View style={{ marginTop: 6 }}>
                    <Label>Manual pages (fallback)</Label>
                    <Field
                      value={item.manualPages}
                      onChangeText={(t) => setFiles((prev) => prev.map((f, i) => i === index ? { ...f, manualPages: t } : f))}
                      placeholder="e.g. 10"
                      keyboardType="number-pad"
                    />
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        </View>

        {/* Legal links */}
        <View style={{ backgroundColor: theme.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: theme.border, marginBottom: 12 }}>
          <Text style={{ fontWeight: '600', color: theme.text, marginBottom: 8 }}>About</Text>
          <Text style={{ color: theme.muted, marginBottom: 10 }}>
            Print4me helps you send print requests with options and pricing.
          </Text>
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <TouchableOpacity onPress={() => Linking.openURL('https://github.com/utpiaa/print4me/blob/main/docs/privacy-policy.md')}>
              <Text style={{ color: theme.primary, fontWeight: '600' }}>Privacy Policy</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => Linking.openURL('https://github.com/utpiaa/print4me/blob/main/docs/terms.md')}>
              <Text style={{ color: theme.primary, fontWeight: '600' }}>Terms</Text>
            </TouchableOpacity>
          </View>
        </View>

        {submitting ? (
          <View style={{ alignItems: 'center', marginVertical: 12 }}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={{ marginTop: 8, color: theme.muted }}>Uploading... {progress}%</Text>
          </View>
        ) : null}

        <PrimaryButton title="Submit Print Request" onPress={submit} disabled={submitting} full />

        <Text style={{ marginTop: 12, color: theme.muted, fontSize: 12 }}>
          API: {apiBaseUrl.replace(/\/$/, '')}/api/print-request
        </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Label({ children }) {
  return <Text style={{ color: theme.muted, marginTop: 8, marginBottom: 6 }}>{children}</Text>;
}

function Field(props) {
  const { multiline } = props;
  return (
    <TextInput
      {...props}
      style={{
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: '#fff',
        paddingHorizontal: 12,
        paddingVertical: multiline ? 10 : 8,
        borderRadius: 8,
        color: theme.text,
        minHeight: multiline ? 80 : undefined,
        textAlignVertical: multiline ? 'top' : 'center',
        marginBottom: 6,
      }}
    />
  );
}

function PrimaryButton({ title, onPress, disabled, full }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        backgroundColor: disabled ? '#9ca3af' : theme.primary,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: full ? 'stretch' : 'flex-start',
      }}
    >
      <Text style={{ color: 'white', fontWeight: '700' }}>{title}</Text>
    </TouchableOpacity>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
      {options.map((opt) => {
        const active = value === opt.key;
        return (
          <TouchableOpacity
            key={opt.key}
            onPress={() => onChange(opt.key)}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: active ? theme.primary : theme.border,
              backgroundColor: active ? '#e5edff' : '#fff',
              marginRight: 8,
            }}
          >
            <Text style={{ color: active ? theme.primaryDark : theme.text }}>{opt.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
