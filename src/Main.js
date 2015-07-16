import {EaselJS} from 'EaselJS';
import {TweenJS} from 'TweenJS';
import {Pages} from './Pages';
import * as Hammer from 'hammer';

export class Main {

    pages;
    canvas;
    stage;
    pagesCount;
    globalContainer;

    constructor(canvas) {

        this.pages = new Array(6);
        this.pagesCount = 0;

        this.canvas = canvas;
        this.canvas.onmousemove = this.onMouseMove.bind(this);

        this.stage = new createjs.Stage(this.canvas);
        this.stage.enableMouseOver(20);
        window.stage = this.stage;

        this.globalContainer = new createjs.Container();
        this.globalContainer.x = 0;
        this.globalContainer.y = 0;
        this.globalContainer.orgX = this.globalContainer.x;

        createjs.Ticker.timingMode = createjs.Ticker.RAF;
        createjs.Ticker.setFPS(30);
        createjs.Ticker.addEventListener("tick", this.stage);

        this.initHammer();
        this.loadPages();
    }

    initHammer() {
        var mc = new Hammer.Manager(this.canvas, {
            recognizers: [
                [Hammer.Swipe], [Hammer.Tap], [Hammer.Pan], [Hammer.Pinch]
            ]
        });

        mc.on('swipe', this.onSwipe.bind(this));
        mc.on('pan', this.onPan.bind(this));
        mc.on('panend', this.onPanEnd.bind(this));
        mc.on('tap', this.onTap.bind(this));
    }

    loadPages() {
        for (let i = 0; i < this.pages.length; i++) {
            this.pages[i] = new Image();
            this.pages[i].src = "img/page_" + (i + 1) + ".png";
            this.pages[i].onload = this.onImageLoad.bind(this);
        }
    }

    onImageLoad() {
        this.pagesCount++;
        if (this.pagesCount >= this.pages.length) {
            let pages = Pages.createPages(this.pages, this.globalContainer);
            for (let i = 0; i < pages.length; i++) {
                this.globalContainer.addChild(pages[i]);
            }
            stage.addChild(this.globalContainer);
            stage.update();
        }
    }

    onSwipe(ev) {
    }

    onPanEnd(ev) {
        this.globalContainer.orgX = this.globalContainer.x;
    }

    onPan(ev) {
        let x = this.globalContainer.orgX + ev.deltaX;
        createjs.Tween.get(this.globalContainer).to({x: x});
    }

    onTap(ev) {
    }

    onClick(ev) {
    }

    onMouseMove(e) {
        if (!e) {
            e = window.event;
        }
        this.stage.mouseX = e.pageX - this.canvas.offsetLeft;
        this.stage.mouseY = e.pageY - this.canvas.offsetTop;
    }

}