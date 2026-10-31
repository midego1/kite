### Changed

- The collapsed sidebar's icon rail now tints a folder with any colour you picked, the default blue included: a folder remembers whether its colour was picked, and one nobody coloured stays as neutral as the system folders. This replaces "a colour other than the default blue" in the earlier rail note. Migration 0086 adds `folders.color_is_custom`; apply it from the database update banner or the [Admin overview](/admin). Until then folders still list and save, and the rail shows a picked blue as neutral. Folders with any other colour stay tinted, as before.
