const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const FFMPEG_STATIC_RELEASE_BASE =
  'https://github.com/ylexsx/ffmpeg-ffprobe-static/releases/download/v8.0.1';
// 根据自己的项目修改目录
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(PROJECT_ROOT, 'resources', 'ffmpeg');
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;


const TARGETS = {
  'win32-x64': {
    url: `${FFMPEG_STATIC_RELEASE_BASE}/win32-x64.zip`,
    ffmpegName: 'ffmpeg.exe',
    ffprobeName: 'ffprobe.exe',
  },
  'win32-arm64': {
    url: `${FFMPEG_STATIC_RELEASE_BASE}/win32-arm64.zip`,
    ffmpegName: 'ffmpeg.exe',
    ffprobeName: 'ffprobe.exe',
  },
  'linux-x64': {
    url: `${FFMPEG_STATIC_RELEASE_BASE}/linux-x64.zip`,
    ffmpegName: 'ffmpeg',
    ffprobeName: 'ffprobe',
  },
  'linux-arm64': {
    url: `${FFMPEG_STATIC_RELEASE_BASE}/linux-arm64.zip`,
    ffmpegName: 'ffmpeg',
    ffprobeName: 'ffprobe',
  },
  'darwin-x64': {
    url: `${FFMPEG_STATIC_RELEASE_BASE}/darwin-x64.zip`,
    ffmpegName: 'ffmpeg',
    ffprobeName: 'ffprobe',
  },
  'darwin-arm64': {
    url: `${FFMPEG_STATIC_RELEASE_BASE}/darwin-arm64.zip`,
    ffmpegName: 'ffmpeg',
    ffprobeName: 'ffprobe',
  },
};

const ensureSupportedTarget = (platform, arch) => {
  const target = `${platform}-${arch}`;
  const config = TARGETS[target];
  if (!config) {
    const supported = Object.keys(TARGETS).join(', ');
    throw new Error(`Unsupported target "${target}". Supported: ${supported}`);
  }
  return { target, config };
};

const exists = async filePath => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const request = (url, redirects = 0) => {
  if (redirects > 10) {
    return Promise.reject(
      new Error(`Too many redirects while downloading ${url}`)
    );
  }

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'ping-im-ffmpeg-downloader',
        },
        timeout: DOWNLOAD_TIMEOUT_MS,
      },
      res => {
        const location = res.headers.location;
        if (
          location &&
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400
        ) {
          res.resume();
          resolve(request(new URL(location, url).toString(), redirects + 1));
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed ${res.statusCode}: ${url}`));
          return;
        }

        resolve(res);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Download timed out: ${url}`));
    });
    req.on('error', reject);
  });
};

const downloadFile = async (url, destination) => {
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const response = await request(url);
  const file = createWriteStream(destination);

  await new Promise((resolve, reject) => {
    response.pipe(file);
    response.on('error', reject);
    file.on('finish', resolve);
    file.on('error', reject);
  });
};

const findEndOfCentralDirectory = buffer => {
  const signature = 0x06054b50;
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);

  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }

  throw new Error('Invalid ZIP archive: cannot find central directory');
};

const resolveZipEntryPath = (destination, entryName) => {
  const normalizedName = entryName.replace(/\\/g, '/');
  const outputPath = path.resolve(destination, normalizedName);
  const outputRoot = path.resolve(destination);

  if (
    outputPath !== outputRoot &&
    !outputPath.startsWith(`${outputRoot}${path.sep}`)
  ) {
    throw new Error(`Unsafe ZIP entry path: ${entryName}`);
  }

  return outputPath;
};

const extractZip = async (archivePath, destination) => {
  await fs.mkdir(destination, { recursive: true });

  const buffer = await fs.readFile(archivePath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('Invalid ZIP archive: bad central directory entry');
    }

    const compressionMethod = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const externalAttributes = buffer.readUInt32LE(centralOffset + 38);
    const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
    const entryName = buffer
      .subarray(centralOffset + 46, centralOffset + 46 + fileNameLength)
      .toString('utf8');

    centralOffset += 46 + fileNameLength + extraLength + commentLength;

    const outputPath = resolveZipEntryPath(destination, entryName);
    if (entryName.endsWith('/')) {
      await fs.mkdir(outputPath, { recursive: true });
      continue;
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP archive: bad local header for ${entryName}`);
    }

    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart =
      localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;

    if (compressionMethod === 0) {
      content = compressed;
    } else if (compressionMethod === 8) {
      content = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(
        `Unsupported ZIP compression method ${compressionMethod} for ${entryName}`
      );
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content);

    const mode = (externalAttributes >>> 16) & 0o777;
    if (mode && process.platform !== 'win32') {
      await fs.chmod(outputPath, mode);
    }
  }
};

const walk = async directory => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
};

const findBinary = async (directory, name) => {
  const files = await walk(directory);
  const normalizedName = name.toLowerCase();
  const candidates = files.filter(
    file => path.basename(file).toLowerCase() === normalizedName
  );

  const inBinDirectory = candidates.find(
    file => path.basename(path.dirname(file)).toLowerCase() === 'bin'
  );

  const found = inBinDirectory || candidates[0];
  if (!found) {
    throw new Error(`Cannot find ${name} in extracted files`);
  }

  return found;
};

const copyBinary = async (source, destination) => {
  await fs.copyFile(source, destination);
  if (process.platform !== 'win32') {
    await fs.chmod(destination, 0o755);
  }
};

const verifyBinary = binaryPath => {
  const result = spawnSync(binaryPath, ['-version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error || result.status !== 0) {
    const message = result.error
      ? result.error.message
      : [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Failed to run ${binaryPath} -version\n${message}`);
  }

  return result.stdout.split(/\r?\n/, 1)[0] || '';
};

const downloadTargetArchive = async ({ config, workDir }) => {
  const archivePath = path.join(workDir, 'ffmpeg.zip');
  const extractDir = path.join(workDir, 'extract');

  console.log(`Downloading ${config.url}`);
  await downloadFile(config.url, archivePath);
  await extractZip(archivePath, extractDir);

  return {
    ffmpeg: await findBinary(extractDir, config.ffmpegName),
    ffprobe: await findBinary(extractDir, config.ffprobeName),
    urls: [config.url],
  };
};

const installTarget = async ({ target, config, force }) => {
  const outputDir = path.join(OUTPUT_ROOT, target);
  const ffmpegPath = path.join(outputDir, config.ffmpegName);
  const ffprobePath = path.join(outputDir, config.ffprobeName);

  if (!force && (await exists(ffmpegPath)) && (await exists(ffprobePath))) {
    return {
      skipped: true,
      target,
      outputDir,
      ffmpegPath,
      ffprobePath,
    };
  }

  await fs.mkdir(OUTPUT_ROOT, { recursive: true });

  const workDir = await fs.mkdtemp(
    path.join(OUTPUT_ROOT, `.download-${target}-`)
  );
  const stagingDir = path.join(workDir, 'staging');

  try {
    const downloaded = await downloadTargetArchive({
      config,
      workDir,
    });

    await fs.mkdir(stagingDir, { recursive: true });
    const stagedFfmpeg = path.join(stagingDir, config.ffmpegName);
    const stagedFfprobe = path.join(stagingDir, config.ffprobeName);

    await copyBinary(downloaded.ffmpeg, stagedFfmpeg);
    await copyBinary(downloaded.ffprobe, stagedFfprobe);

    const ffmpegVersion = verifyBinary(stagedFfmpeg);
    const ffprobeVersion = verifyBinary(stagedFfprobe);
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outputDir), { recursive: true });
    await fs.rename(stagingDir, outputDir);

    return {
      skipped: false,
      target,
      outputDir,
      ffmpegPath,
      ffprobePath,
      ffmpegVersion,
      ffprobeVersion,
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
};

const downloadFfmpegLgpl = async (options = {}) => {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;

  const { target, config } = ensureSupportedTarget(platform, arch);

  return installTarget({
    target,
    config,
    force: options.force === true,
  });
};

module.exports = {
  downloadFfmpegLgpl,
};
