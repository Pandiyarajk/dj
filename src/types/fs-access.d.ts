/**
 * File System Access API surface not yet in TypeScript's DOM lib
 * (Chromium only: showDirectoryPicker and handle permissions).
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker?(options?: { id?: string; mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
}
