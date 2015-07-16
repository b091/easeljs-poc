import {Hotspot} from './Hotspot.js';

export class Pages {

    static createPages(pictures) {
        let pages = [];
        for (let index = 0; index < pictures.length; index++) {
            pages.push(Pages.createPage(pictures[index], index));
        }
        return pages;
    }

    static createPage(src, index) {
        let pageContainer = Pages.createPageContainer(src, index);
        pageContainer.addChild(new createjs.Bitmap(src));

        for (let xyz = 0; xyz <= 50; xyz++) {
            Pages.createHotSpot(pageContainer);
        }

        return pageContainer;
    }

    static createHotSpot(container) {
        let picture = new Image();
        let index = Math.floor(Math.random() * 3) + 1;
        picture.src = "img/hotspot_" + index + ".jpeg";
        picture.onload = () => {
            let hotspot = new Hotspot(picture);
            container.addChild(hotspot);
            Hotspot.setRandomPosition(hotspot);
            stage.update();
        };
    }

    static createPageContainer(picture, index) {
        let pageContainer = new createjs.Container();
        let ratio = Math.min(window.innerWidth / picture.width, window.innerHeight / picture.height);
        let rectWidth = ratio * picture.width;

        pageContainer.scaleX = pageContainer.scaleY = window.innerHeight / picture.height;
        pageContainer.x = (picture.width - rectWidth) * index;
        pageContainer.y = 0;

        return pageContainer;
    }

}


