use anyhow::{Context, Result, ensure};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, WIN32_ERROR};
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_WOW64_64KEY,
    REG_DWORD, REG_OPTION_NON_VOLATILE, RRF_RT_REG_DWORD, RRF_SUBKEY_WOW6464KEY, RegCloseKey,
    RegCreateKeyExW, RegGetValueW, RegOpenKeyExW, RegQueryInfoKeyW, RegSetValueExW,
};
use windows::core::{PCWSTR, PWSTR, w};

const KEY: PCWSTR = w!(r"SOFTWARE\Policies\Claude");
const VALUE: PCWSTR = w!("disableAutoUpdates");

pub fn disable() -> Result<()> {
    apply(HKEY_LOCAL_MACHINE, KEY, HKEY_CURRENT_USER, KEY)
}

fn apply(machine: HKEY, machine_path: PCWSTR, user: HKEY, user_path: PCWSTR) -> Result<()> {
    // Desktop ignores the entire HKCU policy if the machine key contains any values.
    if machine_has_values(machine, machine_path)? {
        ensure!(
            read_value(machine, machine_path)? == Some(1),
            "Claude Desktop 由机器策略管理，当前用户无法关闭自动更新。请由管理员设置 disableAutoUpdates=1。"
        );
        return Ok(());
    }
    if read_value(user, user_path)? != Some(1) {
        let key = create_user_key(user, user_path)?;
        unsafe { RegSetValueExW(key.0, VALUE, 0, REG_DWORD, Some(&1u32.to_le_bytes())) }
            .ok()
            .context("无法写入当前用户的 Claude Desktop 自动更新策略")?;
        ensure!(
            read_value(user, user_path)? == Some(1),
            "未能确认当前用户的 Claude Desktop 自动更新策略"
        );
    }
    Ok(())
}

struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn missing(result: WIN32_ERROR) -> bool {
    result == ERROR_FILE_NOT_FOUND || result == ERROR_PATH_NOT_FOUND
}

fn machine_has_values(root: HKEY, path: PCWSTR) -> Result<bool> {
    let mut key = HKEY::default();
    let result = unsafe { RegOpenKeyExW(root, path, 0, KEY_QUERY_VALUE | KEY_WOW64_64KEY, &mut key) };
    if missing(result) {
        return Ok(false);
    }
    result.ok().context("无法读取 Claude Desktop 机器策略")?;
    let key = Key(key);
    let mut count = 0;
    unsafe {
        RegQueryInfoKeyW(
            key.0, PWSTR::null(), None, None, None, None, None, Some(&mut count), None, None,
            None, None,
        )
    }
    .ok()
    .context("无法确认 Claude Desktop 机器策略")?;
    Ok(count != 0)
}

fn read_value(root: HKEY, path: PCWSTR) -> Result<Option<u32>> {
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let result = unsafe {
        RegGetValueW(
            root, path, VALUE, RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, None,
            Some((&mut value as *mut u32).cast()), Some(&mut size),
        )
    };
    if missing(result) {
        return Ok(None);
    }
    result.ok().context("无法读取 Claude Desktop 自动更新策略")?;
    Ok(Some(value))
}

fn create_user_key(root: HKEY, path: PCWSTR) -> Result<Key> {
    let mut key = HKEY::default();
    unsafe {
        RegCreateKeyExW(
            root, path, 0, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE | KEY_WOW64_64KEY,
            None, &mut key, None,
        )
    }
    .ok()
    .context("无法打开当前用户的 Claude Desktop 策略")?;
    Ok(Key(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Registry::RegDeleteTreeW;
    use windows::core::HSTRING;

    struct Fixture(HSTRING);

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &self.0) };
        }
    }

    #[test]
    fn desktop_update_policy_respects_machine_scope() {
        let root = format!(r"Software\ClaudeMomPolicyTest-{}", uuid::Uuid::new_v4());
        let _fixture = Fixture(HSTRING::from(&root));
        let machine = HSTRING::from(format!(r"{root}\Machine"));
        let user = HSTRING::from(format!(r"{root}\User"));
        let hive = HKEY_CURRENT_USER;
        let machine_path = PCWSTR(machine.as_ptr());
        let user_path = PCWSTR(user.as_ptr());
        let configure = || apply(hive, machine_path, hive, user_path);
        let set = |path, name, n: u32| {
            let key = create_user_key(hive, path).unwrap();
            unsafe { RegSetValueExW(key.0, name, 0, REG_DWORD, Some(&n.to_le_bytes())) }
                .ok()
                .unwrap();
        };

        configure().unwrap();
        assert_eq!(read_value(hive, user_path).unwrap(), Some(1));
        assert!(!machine_has_values(hive, machine_path).unwrap());

        set(user_path, VALUE, 0);
        drop(create_user_key(hive, machine_path).unwrap());
        configure().unwrap();
        assert_eq!(read_value(hive, user_path).unwrap(), Some(1));

        set(user_path, VALUE, 0);
        set(machine_path, w!("OtherPolicy"), 1);
        assert!(configure().is_err());
        assert_eq!(read_value(hive, machine_path).unwrap(), None);
        assert_eq!(read_value(hive, user_path).unwrap(), Some(0));

        set(machine_path, VALUE, 0);
        assert!(configure().is_err());
        set(machine_path, VALUE, 1);
        configure().unwrap();
        assert_eq!(read_value(hive, user_path).unwrap(), Some(0));
    }
}
