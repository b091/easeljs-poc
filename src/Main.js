import {EaselJS} from 'EaselJS';
import {TweenJS} from 'TweenJS';
import {Pages} from './Pages';
import * as Hammer from 'hammer';

export class Main {

    pages;
    canvas;
    stage;
    pagesCount;
    animate;
    halfCanvasWidth;
    halfCanvasWidthByTen;

    constructor() {

        this.canvas = document.getElementById('demoCanvas');
        this.canvas.onmousemove = this.onMouseMove.bind(this);

        var mc = new Hammer.Manager(this.canvas, {
            recognizers: [
                [Hammer.Swipe], [Hammer.Tap], [Hammer.Pan], [Hammer.Pinch]
            ]
        });

        mc.on('swipe', this.onSwipe.bind(this));
        mc.on('pan', this.onPan.bind(this));
        mc.on('panend', this.onPanEnd.bind(this));
        mc.on('tap', this.onTap.bind(this));
        
        this.stage = new createjs.Stage(this.canvas);

        this.pages = new Array(6);
        this.pagesCount = 0;
        this.animate = false;
        this.stage.enableMouseOver(20);

        createjs.Ticker.timingMode = createjs.Ticker.RAF;
        //createjs.Ticker.timingMode = createjs.Ticker.RAF_SYNCHED;

        createjs.Ticker.setFPS(30);
        createjs.Ticker.addEventListener("tick", this.stage);

        window.stage = this.stage;

        this.loadPages();
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
        if (this.pagesCount >=  this.pages.length) {
            Pages.createPages(this.pages);
            stage.update();
        }
    }

    onSwipe(ev) {
    }
    
    onPanEnd(ev){
        for (let i = 0; i < this.pages.length; i++) {
            if (this.stage.children[i]) {
                this.stage.children[i].orgX = this.stage.children[i].x;
            }
        }
    }
    
    onPan(ev){
        for (let i = 0; i < this.pages.length; i++) {
            if (this.stage.children[i]) {
                let x = this.stage.children[i].orgX + ev.deltaX;
                createjs.Tween.get(this.stage.children[i])
                    .to({ x: x });
            }
        }
    }

    onTap(ev) {
    }

    onClick(ev){
    }

    onMouseMove(e) {
        if (!e) {
            e = window.event;
        }
        this.stage.mouseX = e.pageX - this.canvas.offsetLeft;
        this.stage.mouseY = e.pageY - this.canvas.offsetTop;
    }

}