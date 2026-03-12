/*
 * Credits:
 * This file is based on code from the Dash to Panel extension by Jason DeRose
 * and code from the Taskbar extension by Zorin OS
 * Some code was also adapted from the upstream Gnome Shell source code.
 */

import {
    Clutter,
    GLib,
    GObject,
    Meta,
    St,
    Gio,
} from './dependencies/gi.js';

import {
    BoxPointer,
    Main,
    PopupMenu,
    Workspace,
} from './dependencies/shell/ui.js';

import {
    Docking,
    Theming,
    Utils,
} from './imports.js';

import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';
import Gvc from 'gi://Gvc';

const PREVIEW_MAX_WIDTH = 250;
const PREVIEW_MAX_HEIGHT = 150;

const PREVIEW_ANIMATION_DURATION = 250;
const MAX_PREVIEW_GENERATION_ATTEMPTS = 15;

const MENU_MARGINS = 10;

export class WindowPreviewMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        super(source, 0.5, Utils.getPosition());

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this._source = source;
        this._app = this._source.app;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(
            this._source.monitorIndex);
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);

        this.actor.add_style_class_name('app-menu');
        this.actor.set_style(
            `max-width: ${Math.round(workArea.width / scaleFactor) - MENU_MARGINS}px; ` +
            `max-height: ${Math.round(workArea.height / scaleFactor) - MENU_MARGINS}px;`);
        this.actor.hide();

        // Chain our visibility and lifecycle to that of the source
        this._mappedId = this._source.connect('notify::mapped', () => {
            if (!this._source.mapped)
                this.close();
        });
        this._destroyId = this._source.connect('destroy', this.destroy.bind(this));

        Utils.addActor(Main.uiGroup, this.actor);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _redisplay() {
        // 1. Очищаем старые миниатюры
        if (this._previewBox)
            this._previewBox.destroy();

        // 2. Очищаем старую медиа-панель
        if (this._mediaSection) {
            this._mediaSection.destroy();
            this._mediaSection = null;
        }

        // 3. Создаем и добавляем список окон
        this._previewBox = new WindowPreviewList(this._source);
        this.addMenuItem(this._previewBox);
        this._previewBox._redisplay();

        // 4. Ищем медиаплеер асинхронно, не блокируя цикл событий
        this._injectMediaControlsAsync();
    }

    _injectMediaControlsAsync() {
        if (!this._app) return;
        const appId = this._app.get_id().replace('.desktop', '').toLowerCase();
        const appNameParts = appId.split('.');
        const baseName = appNameParts[appNameParts.length - 1];

        // Используем асинхронный вызов .call() вместо синхронного .call_sync()
        Gio.DBus.session.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try {
                    const result = conn.call_finish(res);
                    const [names] = result.deep_unpack();
                    
                    const matchedName = names.find(name => {
                        if (!name.startsWith('org.mpris.MediaPlayer2.')) return false;
                        const mprisId = name.toLowerCase();
                        return mprisId.includes(appId) || mprisId.includes(baseName);
                    });

                    if (matchedName) {
                        try {
                            // Проверяем, не было ли меню закрыто пользователем за эти миллисекунды
                            // Обращение к this._previewBox выкинет ошибку, если объект уничтожен
                            if (!this._previewBox || this._mediaSection) return;

                            const mediaControls = this._buildMediaControls(matchedName);
                            if (mediaControls) {
                                this._mediaSection = new PopupMenu.PopupMenuSection();
                                this._mediaSection.actor.add_child(mediaControls);
                                this.addMenuItem(this._mediaSection);
                            }
                        } catch (err) {
                            // Изящно игнорируем ошибку already disposed, если меню успели закрыть
                            if (err.message && !err.message.includes('already disposed')) {
                                console.error(`[Dash-to-Dock] Ошибка добавления UI: ${err.message}`);
                            }
                        }
                    }
                } catch (e) {
                    // Игнорируем ошибки сети/DBus
                }
            }
        );
    }

    popup(isHover = false) {
        this.isHoverMenu = isHover;
        this.blockSourceEvents = !isHover;

        const windows = this._source.getInterestingWindows();
        if (windows.length > 0) {
            this._redisplay();
            
            // Стандартное открытие GNOME (меню будет отображаться корректно)
            this.open(BoxPointer.PopupAnimation.FULL);
            
            // Не забираем фокус клавиатуры, если это hover
            if (!isHover) {
                this.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
            }
            
            this._source.emit('sync-tooltip');
        }
    }

    close(animate) {
        const event = Clutter.get_current_event();
        
        // Если меню закрывается, и это hover-меню, проверяем причину закрытия
        if (this.isHoverMenu && this.isOpen && event) {
            const type = event.type();
            
            // Если причиной закрытия стал клик мыши
            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.BUTTON_RELEASE) {
                
                // Получаем координаты клика
                const [x, y] = event.get_coords();
                
                // Проверяем, попал ли клик в границы нашей иконки (this._source)
                const [success, relX, relY] = this._source.transform_stage_point(x, y);
                
                if (success && relX >= 0 && relX <= this._source.width && relY >= 0 && relY <= this._source.height) {
                    
                    const button = event.get_button();
                    
                    // БИНГО! Пользователь кликнул по иконке.
                    // Откладываем выполнение на долю секунды (через GLib.idle_add), 
                    // чтобы Wayland успел завершить закрытие меню и снять блокировку ввода.
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        if (button === 1) { // Левый клик
                            const wins = this._source.getInterestingWindows();
                            if (wins.length > 0) {
                                Main.activateWindow(wins[0]); // Разворачиваем окно
                            } else {
                                this._source.app.activate();
                            }
                        } else if (button === 2) { // Средний клик
                            this._source.launchNewWindow();
                        } else if (button === 3) { // Правый клик
                            this._source.popupMenu();
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        }

        // Обязательно вызываем стандартное закрытие, чтобы ничего не ломалось
        super.close(animate);
    }

    _onDestroy() {
        if (this._mappedId)
            this._source.disconnect(this._mappedId);

        if (this._destroyId)
            this._source.disconnect(this._destroyId);
    }
    
    
    _buildMediaControls(mprisName) {
        const mainContainer = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'margin-top: 10px; margin-bottom: 5px;'
        });

        // ==========================================
        // ЧАСТЬ 1: УПРАВЛЕНИЕ ВОСПРОИЗВЕДЕНИЕМ (MPRIS)
        // ==========================================
        const buttonsContainer = new St.BoxLayout({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'media-controls'
        });

        const playIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 22,
            style_class: 'popup-menu-icon'
        });

        const updatePlayIcon = (status) => {
            playIcon.icon_name = status === 'Playing' 
                ? 'media-playback-pause-symbolic' 
                : 'media-playback-start-symbolic';
        };

        const callMpris = (method) => {
            Gio.DBus.session.call(
                mprisName, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', method,
                null, null, Gio.DBusCallFlags.NONE, -1, null,
                (conn, res) => { try { conn.call_finish(res); } catch (e) {} }
            );
        };

        const createButton = (icon, action) => {
            const btn = new St.Button({
                child: icon instanceof St.Icon ? icon : new St.Icon({
                    icon_name: icon, icon_size: 24, style_class: 'popup-menu-icon'
                }),
                style_class: 'button',
                reactive: true, can_focus: true, track_hover: true,
                style: 'margin-left: 8px; margin-right: 8px;'
            });
            btn.connect('clicked', () => callMpris(action));
            return btn;
        };

        buttonsContainer.add_child(createButton('media-skip-backward-symbolic', 'Previous'));
        buttonsContainer.add_child(createButton(playIcon, 'PlayPause'));
        buttonsContainer.add_child(createButton('media-skip-forward-symbolic', 'Next'));
        mainContainer.add_child(buttonsContainer);


        // ==========================================
        // ЧАСТЬ 2: УПРАВЛЕНИЕ ГРОМКОСТЬЮ (GVC / ОС МИКШЕР)
        // ==========================================
        const volumeContainer = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'margin-top: 18px;' // Отступ, который мы настроили ранее
        });
        
        const volIcon = new St.Icon({
            icon_name: 'audio-volume-muted-symbolic',
            icon_size: 16,
            style_class: 'popup-menu-icon',
            style: 'margin-right: 10px;'
        });
        
        const volumeSlider = new Slider(0);
        volumeSlider.width = 200;
        volumeSlider.y_align = Clutter.ActorAlign.CENTER;
        volumeSlider.reactive = false; 
        volumeSlider.opacity = 128;    

        volumeContainer.add_child(volIcon);
        volumeContainer.add_child(volumeSlider);
        mainContainer.add_child(volumeContainer);

        let isUpdatingVolume = false;
        let appStream = null;
        
        // Переменные для хранения подписок на сигналы и кэша громкости
        let streamVolumeId = 0;
        let streamMutedId = 0;
        let lastUserVolume = -1; // -1 означает, что пользователь еще не трогал ползунок

        const mixerControl = new Gvc.MixerControl({ name: 'DashToDock Volume' });
        mixerControl.open();

        const appId = this._app.get_id().replace('.desktop', '').toLowerCase();
        const appNameParts = appId.split('.');
        const baseName = appNameParts[appNameParts.length - 1];

        const updateSliderFromStream = () => {
            if (!appStream || isUpdatingVolume) return;
            isUpdatingVolume = true;
            
            const maxVol = mixerControl.get_vol_max_norm();
            volumeSlider.value = appStream.volume / maxVol;
            lastUserVolume = volumeSlider.value; // Запоминаем текущую громкость потока
            
            if (appStream.is_muted || volumeSlider.value === 0) {
                volIcon.icon_name = 'audio-volume-muted-symbolic';
            } else if (volumeSlider.value < 0.3) {
                volIcon.icon_name = 'audio-volume-low-symbolic';
            } else if (volumeSlider.value < 0.7) {
                volIcon.icon_name = 'audio-volume-medium-symbolic';
            } else {
                volIcon.icon_name = 'audio-volume-high-symbolic';
            }
            isUpdatingVolume = false;
        };

        // Функция аккуратного отключения от мертвого потока
        const clearStream = () => {
            if (appStream) {
                if (streamVolumeId) appStream.disconnect(streamVolumeId);
                if (streamMutedId) appStream.disconnect(streamMutedId);
            }
            appStream = null;
            streamVolumeId = 0;
            streamMutedId = 0;
        };

        // Функция подключения к новому потоку (например, при смене трека)
        const attachToStream = (newStream) => {
            clearStream(); // Отключаемся от старого
            appStream = newStream;

            volumeSlider.reactive = true; 
            volumeSlider.opacity = 255;

            // 1. Мгновенно фиксируем ползунок визуально, чтобы он не прыгал перед глазами
            if (lastUserVolume !== -1) {
                isUpdatingVolume = true;
                volumeSlider.value = lastUserVolume;
                
                if (lastUserVolume === 0) volIcon.icon_name = 'audio-volume-muted-symbolic';
                else if (lastUserVolume < 0.3) volIcon.icon_name = 'audio-volume-low-symbolic';
                else if (lastUserVolume < 0.7) volIcon.icon_name = 'audio-volume-medium-symbolic';
                else volIcon.icon_name = 'audio-volume-high-symbolic';
                isUpdatingVolume = false;
            }

            // 2. Делаем паузу в 200мс, чтобы приложение успело применить свои внутренние настройки
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                // Проверяем, актуален ли еще поток (пользователь мог быстро пропустить 3 трека подряд)
                if (appStream !== newStream) return GLib.SOURCE_REMOVE;

                // 3. Принудительно перезаписываем громкость приложения нашей сохраненной
                if (lastUserVolume !== -1) {
                    const maxVol = mixerControl.get_vol_max_norm();
                    appStream.volume = lastUserVolume * maxVol;
                    appStream.push_volume();
                    
                    if (appStream.is_muted && lastUserVolume > 0) {
                        appStream.change_is_muted(false);
                    }
                } else {
                    lastUserVolume = appStream.volume / mixerControl.get_vol_max_norm();
                }

                updateSliderFromStream();

                // 4. И только теперь подписываемся на внешние изменения (когда "буря" улеглась)
                streamVolumeId = appStream.connect('notify::volume', updateSliderFromStream);
                streamMutedId = appStream.connect('notify::is-muted', updateSliderFromStream);

                return GLib.SOURCE_REMOVE;
            });
        };

        const findAudioStream = () => {
            const streams = mixerControl.get_sink_inputs();
            const foundStream = streams.find(stream => {
                const streamAppId = (stream.get_application_id() || '').toLowerCase();
                const streamName = (stream.get_name() || '').toLowerCase();
                return streamAppId === appId || streamAppId.includes(baseName) || streamName.includes(baseName);
            });

            if (foundStream) {
                if (foundStream !== appStream) {
                    attachToStream(foundStream); // Подключаемся к новому
                }
            } else {
                // Если поток исчез (поставили на паузу в браузере и он убил поток)
                clearStream();
                volumeSlider.reactive = false;
                volumeSlider.opacity = 128;
            }
        };

        // Подписываемся на события появления и исчезновения потоков
        mixerControl.connect('state-changed', (control, state) => {
            if (state === Gvc.MixerControlState.READY) findAudioStream();
        });
        mixerControl.connect('stream-added', findAudioStream);
        mixerControl.connect('stream-removed', findAudioStream);

        volumeSlider.connect('notify::value', () => {
            if (isUpdatingVolume || !appStream) return;
            isUpdatingVolume = true;

            lastUserVolume = volumeSlider.value; // Обновляем пользовательский кэш

            const maxVol = mixerControl.get_vol_max_norm();
            appStream.volume = volumeSlider.value * maxVol;
            appStream.push_volume();

            if (appStream.is_muted && volumeSlider.value > 0) {
                appStream.change_is_muted(false);
            }

            if (volumeSlider.value === 0) volIcon.icon_name = 'audio-volume-muted-symbolic';
            else if (volumeSlider.value < 0.3) volIcon.icon_name = 'audio-volume-low-symbolic';
            else if (volumeSlider.value < 0.7) volIcon.icon_name = 'audio-volume-medium-symbolic';
            else volIcon.icon_name = 'audio-volume-high-symbolic';

            isUpdatingVolume = false;
        });


        // ==========================================
        // ЧАСТЬ 3: СИНХРОНИЗАЦИЯ MPRIS (ТОЛЬКО СТАТУС ПЛЕЕРА)
        // ==========================================
        Gio.DBus.session.call(
            mprisName, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'PlaybackStatus']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const result = conn.call_finish(res);
                    updatePlayIcon(result.deep_unpack()[0].deep_unpack());
                } catch (e) {}
            }
        );

        const signalId = Gio.DBus.session.signal_subscribe(
            mprisName, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', '/org/mpris/MediaPlayer2',
            null, Gio.DBusSignalFlags.NONE,
            (conn, sender, objectPath, iface, signal, parameters) => {
                const [interfaceName, changedProperties] = parameters.deep_unpack();
                if (interfaceName === 'org.mpris.MediaPlayer2.Player' && changedProperties['PlaybackStatus']) {
                    updatePlayIcon(changedProperties['PlaybackStatus'].deep_unpack());
                }
            }
        );

        // Очистка памяти при закрытии меню
        mainContainer.connect('destroy', () => {
            if (signalId) Gio.DBus.session.signal_unsubscribe(signalId);
            clearStream();
            mixerControl.close();
        });

        return mainContainer;
    }
}

class WindowPreviewList extends PopupMenu.PopupMenuSection {
    constructor(source) {
        super();
        this.actor = new St.ScrollView({
            name: 'dashtodockWindowScrollview',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            enable_mouse_scrolling: true,
        });

        this.actor.connect('scroll-event', this._onScrollEvent.bind(this));

        const position = Utils.getPosition();
        this.isHorizontal = position === St.Side.BOTTOM || position === St.Side.TOP;
        this.box.set_vertical(!this.isHorizontal);
        this.box.set_name('dashtodockWindowList');
        Utils.addActor(this.actor, this.box);
        this.actor._delegate = this;

        this._shownInitially = false;

        this._source = source;
        this.app = source.app;

        this._redisplayId = Main.initializeDeferredWork(this.actor, this._redisplay.bind(this));

        this.actor.connect('destroy', this._onDestroy.bind(this));
        this._stateChangedId = this.app.connect('windows-changed',
            this._queueRedisplay.bind(this));
    }

    _queueRedisplay() {
        Main.queueDeferredWork(this._redisplayId);
    }

    _onScrollEvent(actor, event) {
        // Event coordinates are relative to the stage but can be transformed
        // as the actor will only receive events within his bounds.
        const [stageX, stageY] = event.get_coords();
        const [,, eventY] = actor.transform_stage_point(stageX, stageY);
        const [, actorH] = actor.get_size();

        // If the scroll event is within a 1px margin from
        // the relevant edge of the actor, let the event propagate.
        if (eventY >= actorH - 2)
            return Clutter.EVENT_PROPAGATE;

        // Skip to avoid double events mouse
        if (event.is_pointer_emulated())
            return Clutter.EVENT_STOP;

        let adjustment, delta;

        if (this.isHorizontal)
            adjustment = this.actor.get_hscroll_bar().get_adjustment();
        else
            adjustment = this.actor.get_vscroll_bar().get_adjustment();

        const increment = adjustment.step_increment;

        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = -increment;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = Number(increment);
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            delta = dy * increment;
            delta += dx * increment;
            break;
        }
        }

        adjustment.set_value(adjustment.get_value() + delta);

        return Clutter.EVENT_STOP;
    }

    _onDestroy() {
        this.app.disconnect(this._stateChangedId);
        this._stateChangedId = 0;
    }

    _createPreviewItem(window) {
        const preview = new WindowPreviewMenuItem(window, Utils.getPosition());
        return preview;
    }

    _redisplay() {
        const children = this._getMenuItems().filter(actor => {
            return actor._window;
        });

        // Windows currently on the menu
        const oldWin = children.map(actor => {
            return actor._window;
        });

        // All app windows with a static order
        const newWin = this._source.getInterestingWindows().sort((a, b) =>
            a.get_stable_sequence() > b.get_stable_sequence());

        const addedItems = [];
        const removedActors = [];

        let newIndex = 0;
        let oldIndex = 0;

        while (newIndex < newWin.length || oldIndex < oldWin.length) {
            const currentOldWin = oldWin[oldIndex];
            const currentNewWin = newWin[newIndex];

            // No change at oldIndex/newIndex
            if (currentOldWin === currentNewWin) {
                oldIndex++;
                newIndex++;
                continue;
            }

            // Window removed at oldIndex
            if (currentOldWin && !newWin.includes(currentOldWin)) {
                removedActors.push(children[oldIndex]);
                oldIndex++;
                continue;
            }

            // Window added at newIndex
            if (currentNewWin && !oldWin.includes(currentNewWin)) {
                addedItems.push({
                    item: this._createPreviewItem(currentNewWin),
                    pos: newIndex,
                });
                newIndex++;
                continue;
            }

            // Window moved
            const insertHere = newWin[newIndex + 1] &&
                             newWin[newIndex + 1] === currentOldWin;
            const alreadyRemoved = removedActors.reduce((result, actor) =>
                result || actor._window === currentNewWin, false);

            if (insertHere || alreadyRemoved) {
                addedItems.push({
                    item: this._createPreviewItem(currentNewWin),
                    pos: newIndex + removedActors.length,
                });
                newIndex++;
            } else {
                removedActors.push(children[oldIndex]);
                oldIndex++;
            }
        }

        for (let i = 0; i < addedItems.length; i++) {
            this.addMenuItem(addedItems[i].item,
                addedItems[i].pos);
        }

        for (let i = 0; i < removedActors.length; i++) {
            const item = removedActors[i];
            if (this._shownInitially)
                item._animateOutAndDestroy();
            else
                item.actor.destroy();
        }

        // Skip animations on first run when adding the initial set
        // of items, to avoid all items zooming in at once
        const animate = this._shownInitially;

        if (!this._shownInitially)
            this._shownInitially = true;

        for (let i = 0; i < addedItems.length; i++)
            addedItems[i].item.show(animate);

        // Workaround for https://bugzilla.gnome.org/show_bug.cgi?id=692744
        // Without it, StBoxLayout may use a stale size cache
        this.box.queue_relayout();

        if (newWin.length < 1)
            this._getTopMenu().close(~0);

        // As for upstream:
        // St.ScrollView always requests space horizontally for a possible vertical
        // scrollbar if in AUTOMATIC mode. Doing better would require implementation
        // of width-for-height in St.BoxLayout and St.ScrollView. This looks bad
        // when we *don't* need it, so turn off the scrollbar when that's true.
        // Dynamic changes in whether we need it aren't handled properly.
        const needsScrollbar = this._needsScrollbar();
        const scrollbarPolicy = needsScrollbar
            ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
        if (this.isHorizontal)
            this.actor.hscrollbarPolicy = scrollbarPolicy;
        else
            this.actor.vscrollbarPolicy = scrollbarPolicy;

        if (needsScrollbar)
            this.actor.add_style_pseudo_class('scrolled');
        else
            this.actor.remove_style_pseudo_class('scrolled');
    }

    _needsScrollbar() {
        const topMenu = this._getTopMenu();
        const topThemeNode = topMenu.actor.get_theme_node();
        if (this.isHorizontal) {
            const [topMinWidth_, topNaturalWidth] =
                topMenu.actor.get_preferred_width(-1);
            const topMaxWidth = topThemeNode.get_max_width();
            return topMaxWidth >= 0 && topNaturalWidth >= topMaxWidth;
        } else {
            const [topMinHeight_, topNaturalHeight] =
                topMenu.actor.get_preferred_height(-1);
            const topMaxHeight = topThemeNode.get_max_height();
            return topMaxHeight >= 0 && topNaturalHeight >= topMaxHeight;
        }
    }

    isAnimatingOut() {
        return this.actor.get_children().reduce((result, actor) => {
            return result || actor.animatingOut;
        }, false);
    }
}

export const WindowPreviewMenuItem = GObject.registerClass(
class WindowPreviewMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(window, position, params) {
        super._init(params);

        this._window = window;
        this._destroyId = 0;
        this._windowAddedId = 0;

        // We don't want this: it adds spacing on the left of the item.
        this.remove_child(this._ornamentIcon);
        this.add_style_class_name('dashtodock-app-well-preview-menu-item');
        this.add_style_class_name(Theming.PositionStyleClass[position]);
        if (Docking.DockManager.settings.customThemeShrink)
            this.add_style_class_name('shrink');

        // Now we don't have to set PREVIEW_MAX_WIDTH and PREVIEW_MAX_HEIGHT as
        // preview size - that made all kinds of windows either stretched or
        // squished (aspect ratio problem)
        this._cloneBin = new St.Bin();

        this._updateWindowPreviewSize();

        // TODO: improve the way the closebutton is layout. Just use some padding
        // for the moment.
        this._cloneBin.set_style('padding-bottom: 0.5em');

        const buttonLayout = Meta.prefs_get_button_layout();
        this.closeButton = new St.Button({
            style_class: 'window-close',
            opacity: 0,
            x_expand: true,
            y_expand: true,
            x_align: buttonLayout.left_buttons.includes(Meta.ButtonFunction.CLOSE)
                ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        Utils.addActor(this.closeButton, new St.Icon({icon_name: 'window-close-symbolic'}));
        this.closeButton.connect('clicked', () => this._closeWindow());

        const overlayGroup = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
        });

        overlayGroup.add_child(this._cloneBin);
        overlayGroup.add_child(this.closeButton);

        const label = new St.Label({text: window.get_title()});
        label.set_style(`max-width: ${PREVIEW_MAX_WIDTH}px`);
        const labelBin = new St.Bin({
            child: label,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._windowTitleId = this._window.connect('notify::title', () => {
            label.set_text(this._window.get_title());
        });

        const box = new St.BoxLayout({
            vertical: true,
            reactive: true,
            x_expand: true,
        });

        if (box.add) {
            box.add(overlayGroup);
            box.add(labelBin);
        } else {
            box.add_child(overlayGroup);
            box.add_child(labelBin);
        }
        this._box = box;
        this.add_child(box);

        this._cloneTexture(window);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();

        // For some crazy clutter / St reason we can't just have this handled
        // automatically or here via vfunc_allocate + vfunc_get_preferred_*
        // because if we do so, the St paddings on first / last child are lost
        const themeNode = this.get_theme_node();
        let [minWidth, naturalWidth] = this._box.get_preferred_width(-1);
        let [minHeight, naturalHeight] = this._box.get_preferred_height(naturalWidth);
        [minWidth, naturalWidth] = themeNode.adjust_preferred_width(minWidth, naturalWidth);
        [minHeight, naturalHeight] = themeNode.adjust_preferred_height(minHeight, naturalHeight);
        this.set({minWidth, naturalWidth, minHeight, naturalHeight});
    }

    _getWindowPreviewSize() {
        const emptySize = [0, 0, 0];

        const mutterWindow = this._window.get_compositor_private();
        if (!mutterWindow?.get_texture())
            return emptySize;

        const [width, height] = mutterWindow.get_size();
        if (!width || !height)
            return emptySize;

        let {previewSizeScale: scale} = Docking.DockManager.settings;
        if (!scale) {
            // a simple example with 1680x1050:
            // * 250/1680 = 0,1488
            // * 150/1050 = 0,1429
            // => scale is 0,1429
            scale = Math.min(1.0, PREVIEW_MAX_WIDTH / width, PREVIEW_MAX_HEIGHT / height);
        }

        scale *= St.ThemeContext.get_for_stage(global.stage).scaleFactor;

        // width and height that we wanna multiply by scale
        return [width, height, scale];
    }

    _updateWindowPreviewSize() {
        // This gets the actual windows size for the preview
        [this._width, this._height, this._scale] = this._getWindowPreviewSize();
        this._cloneBin.set_size(this._width * this._scale, this._height * this._scale);
    }

    _cloneTexture(metaWin) {
        // Newly-created windows are added to a workspace before
        // the compositor finds out about them...
        if (!this._width || !this._height) {
            this._cloneTextureLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
                // Check if there's still a point in getting the texture,
                // otherwise this could go on indefinitely
                this._updateWindowPreviewSize();

                if (this._width && this._height) {
                    this._cloneTexture(metaWin);
                } else {
                    this._cloneAttempt = (this._cloneAttempt || 0) + 1;
                    if (this._cloneAttempt < MAX_PREVIEW_GENERATION_ATTEMPTS)
                        return GLib.SOURCE_CONTINUE;
                }
                delete this._cloneTextureLater;
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const mutterWindow = metaWin.get_compositor_private();
        const clone = new Clutter.Clone({
            source: mutterWindow,
            reactive: true,
            width: this._width * this._scale,
            height: this._height * this._scale,
        });

        // when the source actor is destroyed, i.e. the window closed, first destroy the clone
        // and then destroy the menu item (do this animating out)
        this._destroyId = mutterWindow.connect('destroy', () => {
            clone.destroy();
            this._destroyId = 0; // avoid to try to disconnect this signal from mutterWindow in _onDestroy(),
            // as the object was just destroyed
            this._animateOutAndDestroy();
        });

        this._clone = clone;
        this._mutterWindow = mutterWindow;
        this._cloneBin.set_child(this._clone);

        this._clone.connect('destroy', () => {
            if (this._destroyId) {
                mutterWindow.disconnect(this._destroyId);
                this._destroyId = 0;
            }
            this._clone = null;
        });
    }

    _windowCanClose() {
        return this._window.can_close() &&
               !this._hasAttachedDialogs();
    }

    _closeWindow() {
        this._workspace = this._window.get_workspace();

        // This mechanism is copied from the workspace.js upstream code
        // It forces window activation if the windows don't get closed,
        // for instance because asking user confirmation, by monitoring the opening of
        // such additional confirmation window
        this._windowAddedId = this._workspace.connect('window-added',
            this._onWindowAdded.bind(this));

        this.deleteAllWindows();
    }

    deleteAllWindows() {
        // Delete all windows, starting from the bottom-most (most-modal) one
        // let windows = this._window.get_compositor_private().get_children();
        const windows = this._clone.get_children();
        for (let i = windows.length - 1; i >= 1; i--) {
            const realWindow = windows[i].source;
            const metaWindow = realWindow.meta_window;

            metaWindow.delete(global.get_current_time());
        }

        this._window.delete(global.get_current_time());
    }

    _onWindowAdded(workspace, win) {
        const metaWindow = this._window;

        if (win.get_transient_for() === metaWindow) {
            workspace.disconnect(this._windowAddedId);
            this._windowAddedId = 0;

            // use an idle handler to avoid mapping problems -
            // see comment in Workspace._windowAdded
            const activationEvent = Clutter.get_current_event();
            this._windowAddedLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
                delete this._windowAddedLater;
                this.emit('activate', activationEvent);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _hasAttachedDialogs() {
        // count transient windows
        let n = 0;
        this._window.foreach_transient(() => {
            n++;
        });
        return n > 0;
    }

    vfunc_key_focus_in() {
        super.vfunc_key_focus_in();
        this._showCloseButton();
    }

    vfunc_key_focus_out() {
        super.vfunc_key_focus_out();
        this._hideCloseButton();
    }

    vfunc_enter_event(crossingEvent) {
        this._showCloseButton();
        return super.vfunc_enter_event(crossingEvent);
    }

    vfunc_leave_event(crossingEvent) {
        this._hideCloseButton();
        return super.vfunc_leave_event(crossingEvent);
    }

    _idleToggleCloseButton() {
        this._idleToggleCloseId = 0;

        this._hideCloseButton();

        return GLib.SOURCE_REMOVE;
    }

    _showCloseButton() {
        if (this._windowCanClose()) {
            this.closeButton.show();
            this.closeButton.remove_all_transitions();
            this.closeButton.ease({
                opacity: 255,
                duration: Workspace.WINDOW_OVERLAY_FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _hideCloseButton() {
        if (this.closeButton.has_pointer ||
            this.get_children().some(a => a.has_pointer))
            return;

        this.closeButton.remove_all_transitions();
        this.closeButton.ease({
            opacity: 0,
            duration: Workspace.WINDOW_OVERLAY_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    show(animate) {
        const fullWidth = this.get_width();

        this.opacity = 0;
        this.set_width(0);

        const time = animate ? PREVIEW_ANIMATION_DURATION : 0;
        this.remove_all_transitions();
        this.ease({
            opacity: 255,
            width: fullWidth,
            duration: time,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        });
    }

    _animateOutAndDestroy() {
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            duration: PREVIEW_ANIMATION_DURATION,
        });

        this.ease({
            width: 0,
            height: 0,
            duration: PREVIEW_ANIMATION_DURATION,
            delay: PREVIEW_ANIMATION_DURATION,
            onComplete: () => this.destroy(),
        });
    }

    activate() {
        Main.activateWindow(this._window);
        this._getTopMenu().close();
    }

    _onDestroy() {
        if (this._cloneTextureLater) {
            Utils.laterRemove(this._cloneTextureLater);
            delete this._cloneTextureLater;
        }

        if (this._windowAddedLater) {
            Utils.laterRemove(this._windowAddedLater);
            delete this._windowAddedLater;
        }

        if (this._windowAddedId > 0) {
            this._workspace.disconnect(this._windowAddedId);
            this._windowAddedId = 0;
        }

        if (this._destroyId > 0) {
            this._mutterWindow.disconnect(this._destroyId);
            this._destroyId = 0;
        }

        if (this._windowTitleId > 0) {
            this._window.disconnect(this._windowTitleId);
            this._windowTitleId = 0;
        }
    }
});
